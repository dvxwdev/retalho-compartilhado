import { importCapCutDraft, isCapCutDraft } from "../core/importDraft";
import {
  createProject,
  findSegment,
  SECOND,
  frameDuration,
  isMediaMaterial,
  newId,
  projectDuration,
  segmentEnd,
  type MediaMaterial,
  type Project,
  type ShapeKind,
} from "../core/model";
import {
  addAdjustmentMaterial,
  addShapeMaterial,
  addTextMaterial,
  adjacentMarker,
  beatTimes,
  copySegment,
  cutSourceRanges,
  deleteSegment,
  duplicateSegment,
  extractAudio,
  groupMembers,
  freezeFrame,
  pasteAttributes,
  pasteSegment,
  placeMaterial,
  setGroup,
  splitAtSources,
  splitSegment,
  splitVideoAt,
  toggleMarker,
  updateMaterial,
  updateSegment,
} from "../core/ops";
import { executarComando, trechosDePausa } from "../core/commands";
import { parseCube } from "../core/cube";
import { normalizedVolume } from "../core/loudness";
import { addMotionTemplate, type MotionTemplate } from "../core/motionTemplates";
import { soundingRanges } from "../core/pauses";
import { packProject, unpackProject, type StoredMedia } from "../core/projectFile";
import {
  isHesitation,
  renameWord,
  trackWords,
  wordsFromChunks,
  wordsToCues,
  type PlacedWord,
} from "../core/speech";
import { addSubtitles, decodeSubtitleText, parseSrt } from "../core/subtitles";
import { findBeats, findPauses, findSilences, measureClip } from "../engine/audioJobs";
import { PROXY_HEIGHT, loadProxy, makeProxy, removeProxies } from "../engine/proxy";
import { findSceneCuts } from "../engine/scenes";
import { cancelTranscription, transcribe } from "../engine/speech";
import type { SpeechModel } from "../engine/whisper.worker";
import { mediaKindOf, pool } from "../engine/media";
import { Narration } from "../engine/recorder";
import {
  deleteMedia,
  deleteSavedProject,
  listProjects,
  loadMedia,
  loadProject,
  saveMedia,
  saveProject,
  storedMediaIds,
} from "../engine/persist";
import { edit, getState, onSave, player, resetProject, setState } from "./store";

function bumpMedia(): void {
  setState({ mediaRevision: getState().mediaRevision + 1 });
}

function notify(text: string, details?: string[]): void {
  setState({ notice: { text, details } });
}

async function addMediaFile(file: File): Promise<string> {
  const kind = mediaKindOf(file);
  if (!kind) throw new Error("tipo de arquivo não suportado");
  const { project } = getState();
  const offline = Object.values(project.materials).find(
    (material): material is MediaMaterial =>
      isMediaMaterial(material) && Boolean(material.offline) && material.name === file.name,
  );
  const id = offline?.id ?? newId();
  const probe = await pool.register(id, file, kind);
  await saveMedia(id, file).catch(() =>
    notify(`${file.name} não coube no armazenamento do navegador. Use Salvar antes de fechar, ou ele some.`),
  );
  if (offline) {
    // A clip's timing came from the draft, so only the dimensions are refreshed.
    edit((current) =>
      updateMaterial(current, id, {
        width: probe.width,
        height: probe.height,
        hasAudio: probe.hasAudio,
        offline: false,
      }),
    );
    return id;
  }
  const material: MediaMaterial = { id, name: file.name, ...probe };
  edit((current) => ({ ...current, materials: { ...current.materials, [id]: material } }));
  return id;
}

async function importDraftFile(file: File): Promise<boolean> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    return false;
  }
  if (!isCapCutDraft(parsed)) return false;
  const { project, warnings, offlineFiles } = importCapCutDraft(parsed);
  await keepCurrent();
  pool.clear();
  resetProject(project);
  const files = new Set(Object.values(offlineFiles)).size;
  notify(
    `Draft importado. Adicione os ${files} arquivos de mídia originais para reconectá-los.`,
    warnings.length ? ["Não reproduzido nesta versão:", ...warnings] : undefined,
  );
  return true;
}

/** Adds a colour table to the project and applies it to the selected clip. */
async function importLutFile(file: File): Promise<void> {
  const table = parseCube(await file.text());
  const id = newId();
  await saveMedia(id, file);
  pool.addLut(id, table, file);
  const name = file.name.replace(/\.cube$/i, "");
  const { selection } = getState();
  edit((project) => {
    const next = { ...project, luts: { ...project.luts, [id]: { id, name } } };
    return selection
      ? updateSegment(next, selection, (segment) => {
          segment.lut = { id, strength: 1 };
        })
      : next;
  });
}

async function importFontFile(file: File): Promise<void> {
  const id = newId();
  const name = file.name.replace(/\.[^.]+$/, "");
  await pool.addFont(id, name, file).catch(() => {
    throw new Error("fonte inválida");
  });
  await saveMedia(id, file);
  const { selection, project } = getState();
  const found = selection ? findSegment(project, selection) : null;
  const material = found ? project.materials[found.segment.materialId] : undefined;
  edit((current) => {
    const next = { ...current, fonts: { ...current.fonts, [id]: { id, name } } };
    return material?.kind === "text" ? updateMaterial(next, material.id, { fontFamily: name }) : next;
  });
}

async function restoreLut(id: string, blob: Blob): Promise<void> {
  pool.addLut(id, parseCube(await blob.text()), blob);
}

async function importSubtitleFile(file: File): Promise<void> {
  const cues = parseSrt(decodeSubtitleText(await file.arrayBuffer()));
  if (cues.length === 0) throw new Error("nenhuma legenda encontrada");
  edit((project) => addSubtitles(project, cues));
}

/** The project and all its media as one file, for backups and moving between machines. */
export function buildProjectFile(): Blob {
  const { project } = getState();
  const media: StoredMedia[] = [];
  for (const material of Object.values(project.materials)) {
    const blob = isMediaMaterial(material) ? pool.blob(material.id) : undefined;
    if (blob) media.push({ id: material.id, blob });
  }
  for (const { id } of [...Object.values(project.luts ?? {}), ...Object.values(project.fonts ?? {})]) {
    const blob = pool.blob(id);
    if (blob) media.push({ id, blob });
  }
  return packProject(project, media);
}

export function saveProjectFile(): void {
  const url = URL.createObjectURL(buildProjectFile());
  const link = document.createElement("a");
  link.href = url;
  link.download = `${getState().project.name.replace(/[\\/:*?"<>|]/g, "-") || "projeto"}.retalho`;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

async function openProjectFile(file: File): Promise<void> {
  const { project, media } = await unpackProject(file);
  await keepCurrent();
  pool.clear();
  const unreadable: string[] = [];
  for (const material of Object.values(project.materials)) {
    if (!isMediaMaterial(material)) continue;
    const stored = media.find((item) => item.id === material.id);
    try {
      if (!stored) throw new Error("ausente");
      await pool.register(material.id, stored.blob, material.kind);
      await saveMedia(material.id, stored.blob);
      material.offline = false;
    } catch {
      material.offline = true;
      if (stored) unreadable.push(material.name);
    }
  }
  for (const { id, name } of Object.values(project.luts ?? {})) {
    const stored = media.find((item) => item.id === id);
    try {
      if (!stored) throw new Error("ausente");
      await restoreLut(id, stored.blob);
      await saveMedia(id, stored.blob);
    } catch {
      unreadable.push(name);
    }
  }
  for (const { id, name } of Object.values(project.fonts ?? {})) {
    const stored = media.find((item) => item.id === id);
    try {
      if (!stored) throw new Error("ausente");
      await pool.addFont(id, name, stored.blob);
      await saveMedia(id, stored.blob);
    } catch {
      unreadable.push(name);
    }
  }
  resetProject(project);
  if (unreadable.length) notify("Algumas mídias não puderam ser lidas e ficaram offline.", unreadable);
}

export async function importFiles(files: File[]): Promise<void> {
  const failures: string[] = [];
  for (const file of files) {
    try {
      if (/\.json$/i.test(file.name)) {
        if (!(await importDraftFile(file))) failures.push(`${file.name}: não é um draft válido`);
      } else if (/\.srt$/i.test(file.name)) {
        await importSubtitleFile(file);
      } else if (/\.(ttf|otf|woff2?)$/i.test(file.name)) {
        await importFontFile(file);
      } else if (/\.cube$/i.test(file.name)) {
        await importLutFile(file);
      } else if (/\.retalho$/i.test(file.name)) {
        await openProjectFile(file);
      } else {
        await addMediaFile(file);
      }
    } catch (error) {
      failures.push(`${file.name}: ${(error as Error).message}`);
    }
  }
  bumpMedia();
  if (getState().lightPreview) {
    await prepareProxies().catch((error: Error) => failures.push(`Versão leve: ${error.message}`));
    setState({ task: null });
  }
  void player.renderStill();
  if (failures.length) notify("Alguns arquivos não foram importados.", failures);
}

export function addToTimeline(materialId: string, at?: number, trackId?: string): void {
  const state = getState();
  const material = state.project.materials[materialId];
  if (!material) return;
  const start = at ?? state.playhead;
  let segmentId = "";
  edit((project) => {
    const placed = placeMaterial(project, materialId, start, trackId);
    segmentId = placed.segmentId;
    return placed.project;
  });
  setState({ selection: segmentId });
}

export function addShape(shape: ShapeKind): void {
  const { project, materialId } = addShapeMaterial(getState().project, shape);
  edit(() => project);
  addToTimeline(materialId);
  setState({ panelTab: "shape" });
}

export function addTemplate(template: MotionTemplate): void {
  const { playhead, project } = getState();
  const added = addMotionTemplate(project, template, playhead);
  edit(() => added.project);
  setState({ selection: added.segmentIds[0] ?? null, alsoSelected: added.segmentIds.slice(1) });
}

export function addAdjustment(): void {
  const { project, materialId } = addAdjustmentMaterial(getState().project);
  edit(() => project);
  addToTimeline(materialId);
  setState({ panelTab: "color" });
}

export function addText(): void {
  const { project, materialId } = addTextMaterial(getState().project);
  edit(() => project);
  addToTimeline(materialId);
  setState({ panelTab: "text" });
}

/** Splits the selected clip, or every clip under the playhead when nothing is selected. */
export function splitAtPlayhead(): void {
  const { selection, playhead, project } = getState();
  const targets = selection
    ? [selection]
    : project.tracks.flatMap((track) =>
        track.segments
          .filter((segment) => segment.target.start < playhead && segmentEnd(segment) > playhead)
          .map((segment) => segment.id),
      );
  edit((current) => {
    let next = current;
    for (const id of targets) next = splitSegment(next, id, playhead)?.project ?? next;
    return next;
  });
}

export function deleteSelection(ripple: boolean): void {
  const ids = selectedClips();
  if (ids.length === 0) return;
  edit((project) => ids.reduce((next, id) => deleteSegment(next, id, ripple), project));
  setState({ alsoSelected: [] });
}

/** Every selected clip, the main one first. */
export function selectedClips(): string[] {
  const { selection, alsoSelected } = getState();
  return selection ? [selection, ...alsoSelected] : [];
}

/** Selects a clip and the rest of its group. */
export function selectClip(segmentId: string): void {
  const members = groupMembers(getState().project, segmentId);
  setState({ selection: segmentId, alsoSelected: members.filter((id) => id !== segmentId) });
}

/** Adds a clip to the selection, or takes it out. */
export function toggleInSelection(segmentId: string): void {
  const { project } = getState();
  const current = selectedClips();
  const members = groupMembers(project, segmentId);
  const next = current.includes(segmentId)
    ? current.filter((id) => !members.includes(id))
    : [...current, ...members.filter((id) => !current.includes(id))];
  setState({ selection: next[0] ?? null, alsoSelected: next.slice(1) });
}

export function selectAll(): void {
  const ids = getState().project.tracks.flatMap((track) => track.segments.map((segment) => segment.id));
  setState({ selection: ids[0] ?? null, alsoSelected: ids.slice(1) });
}

/** Groups the selected clips, or ungroups them when they already are one group. */
export function toggleGroup(): void {
  const ids = selectedClips();
  if (ids.length < 2) return;
  const { project } = getState();
  const groups = new Set(ids.map((id) => findSegment(project, id)?.segment.group));
  const alreadyOne = groups.size === 1 && !groups.has(undefined);
  edit((current) => setGroup(current, ids, alreadyOne ? null : newId()));
}

export function copySelection(): void {
  const { selection, project } = getState();
  const clipboard = selection ? copySegment(project, selection) : null;
  if (clipboard) setState({ clipboard });
}

export function cutSelection(): void {
  copySelection();
  deleteSelection(false);
}

export function pasteAtPlayhead(): void {
  const { clipboard, playhead } = getState();
  if (!clipboard) return;
  let segmentId: string | null = null;
  edit((project) => {
    const pasted = pasteSegment(project, clipboard, playhead);
    segmentId = pasted?.segmentId ?? null;
    return pasted?.project ?? project;
  });
  if (segmentId) setState({ selection: segmentId });
}

export function duplicateSelection(): void {
  const { selection } = getState();
  if (!selection) return;
  let segmentId: string | null = null;
  edit((project) => {
    const copied = duplicateSegment(project, selection);
    segmentId = copied?.segmentId ?? null;
    return copied?.project ?? project;
  });
  if (segmentId) setState({ selection: segmentId });
}

export function pasteAttributesToSelection(): void {
  const { clipboard, selection } = getState();
  if (clipboard && selection) edit((project) => pasteAttributes(project, selection, clipboard.segment));
}

export function toggleMarkerAtPlayhead(): void {
  const { playhead } = getState();
  edit((project) => toggleMarker(project, playhead));
}

export function jumpToMarker(direction: 1 | -1): void {
  const { project, playhead } = getState();
  const marker = adjacentMarker(project, playhead, direction);
  if (marker) player.seek(marker.time);
}

export function extractSelectionAudio(): void {
  const { selection, project } = getState();
  const extracted = selection ? extractAudio(project, selection) : null;
  if (!extracted) {
    notify("Selecione um clipe de vídeo com som para extrair o áudio.");
    return;
  }
  edit(() => extracted.project);
  setState({ selection: extracted.segmentId });
}

let narration: { recording: Narration; at: number } | null = null;

/** Starts recording over the timeline, or stops and places the take where it began. */
export async function toggleNarration(): Promise<void> {
  if (narration) {
    const { recording, at } = narration;
    narration = null;
    player.pause();
    setState({ recording: false });
    try {
      const materialId = await addMediaFile(await recording.stop());
      bumpMedia();
      addToTimeline(materialId, at);
    } catch (error) {
      notify(`Não foi possível salvar a narração: ${(error as Error).message}`);
    }
    return;
  }
  const { playhead, project } = getState();
  try {
    const recording = await Narration.start();
    narration = { recording, at: playhead >= projectDuration(project) ? 0 : playhead };
    setState({ recording: true });
    player.play();
  } catch {
    notify("Não foi possível usar o microfone. Verifique a permissão do navegador.");
  }
}

/** Brings clips to the same perceived loudness, in one undo step. */
export async function normalizeClips(segmentIds: string[]): Promise<void> {
  const { project } = getState();
  setState({ audioBusy: getState().audioBusy + 1 });
  const volumes = new Map<string, number>();
  for (const id of segmentIds) {
    const found = findSegment(project, id);
    if (!found) continue;
    const report = await measureClip(found.segment.materialId, found.segment.source);
    const volume = report && normalizedVolume(report);
    if (volume !== null && volume !== undefined) volumes.set(id, volume);
  }
  setState({ audioBusy: getState().audioBusy - 1 });
  if (volumes.size === 0) {
    notify("Não há som para normalizar.");
    return;
  }
  edit((current) => {
    let next = current;
    for (const [id, volume] of volumes) {
      next = updateSegment(next, id, (segment) => {
        segment.volume = volume;
      });
    }
    return next;
  });
}

export async function markBeats(segmentId: string): Promise<void> {
  const found = findSegment(getState().project, segmentId);
  if (!found) return;
  setState({ audioBusy: getState().audioBusy + 1 });
  const beats = await findBeats(found.segment.materialId, found.segment.source);
  setState({ audioBusy: getState().audioBusy - 1 });
  if (!beats?.length) {
    notify("Não encontrei uma batida regular neste clipe.");
    return;
  }
  edit((project) =>
    updateSegment(project, segmentId, (segment) => {
      segment.beats = beats;
    }),
  );
}

const PAUSE_MIN_SECONDS = 0.5;

/** Measures the clip's silences unless that was already done, then cuts by the same rule agents use. */
export async function cutPauses(segmentId: string): Promise<void> {
  const found = findSegment(getState().project, segmentId);
  if (!found) return;
  let measured: { start: number; end: number }[] | null = null;
  if (!found.segment.analise?.pausas) {
    setState({ audioBusy: getState().audioBusy + 1 });
    measured = await findSilences(found.segment.materialId, found.segment.source, PAUSE_MIN_SECONDS);
    setState({ audioBusy: getState().audioBusy - 1 });
    if (!measured) {
      notify("Não encontrei pausas para cortar neste clipe.");
      return;
    }
  }
  const pausas = measured?.map(({ start, end }) => ({ inicio: start / SECOND, fim: end / SECOND }));
  let message = "Não encontrei pausas para cortar neste clipe.";
  edit((project) => {
    const analysed = pausas ? executarComando(project, "analisarPausas", { clipeId: segmentId, pausas }) : null;
    const base = analysed?.ok ? analysed.projeto : project;
    const clip = findSegment(base, segmentId)?.segment;
    const count = clip ? trechosDePausa(clip, PAUSE_MIN_SECONDS * SECOND).length : 0;
    const cut = executarComando(base, "cortarPausas", { clipeId: segmentId, minimo: PAUSE_MIN_SECONDS });
    if (!cut.ok) message = cut.mensagem;
    else if (count) message = `${count} pausa(s) cortada(s).`;
    return cut.ok ? cut.projeto : base;
  });
  notify(message);
}

export async function splitScenes(segmentId: string): Promise<void> {
  const { project } = getState();
  const found = findSegment(project, segmentId);
  const material = found && project.materials[found.segment.materialId];
  if (!found || material?.kind !== "video") return;
  setState({ task: { label: "Procurando cenas", progress: 0 } });
  try {
    const cuts = await findSceneCuts(material, found.segment.source, (progress) =>
      setState({ task: { label: "Procurando cenas", progress } }),
    );
    if (cuts.length) {
      // The search stops within a fraction of a frame, so cuts settle on the nearest frame.
      const frame = frameDuration(project);
      const aligned = cuts.map((cut) => Math.round(cut / frame) * frame);
      edit((current) => splitAtSources(current, segmentId, aligned));
      notify(`Clipe dividido em ${cuts.length + 1} cenas.`);
    } else {
      notify("Não encontrei mudanças de cena neste clipe.");
    }
  } catch (error) {
    notify((error as Error).message);
  } finally {
    setState({ task: null });
    void player.renderStill();
  }
}

export async function transcribeClip(segmentId: string, model: SpeechModel, language: string | null): Promise<void> {
  const found = findSegment(getState().project, segmentId);
  if (!found) return;
  const { materialId, source } = found.segment;
  setState({ task: { label: "Preparando o áudio", progress: null } });
  try {
    const chunks = await transcribe(materialId, source, model, language, (progress) =>
      setState({
        task:
          progress.stage === "download"
            ? { label: "Baixando o modelo", progress: progress.fraction }
            : { label: "Transcrevendo", progress: null },
      }),
    );
    const words = wordsFromChunks(chunks, source.start);
    if (words.length === 0) {
      notify("Não encontrei fala neste clipe.");
      return;
    }
    edit((project) =>
      updateSegment(project, segmentId, (segment) => {
        segment.words = words;
      }),
    );
  } catch (error) {
    if ((error as Error).name !== "AbortError") {
      notify("Não foi possível transcrever. Na primeira vez é preciso internet para baixar o modelo.", [
        (error as Error).message,
      ]);
    }
  } finally {
    setState({ task: null });
  }
}

export function cancelSpeech(): void {
  cancelTranscription();
}

export function createCaptions(segmentId: string): void {
  const { project } = getState();
  const found = findSegment(project, segmentId);
  const cues = found ? wordsToCues(trackWords(project, found.track.id)) : [];
  if (cues.length === 0) return;
  edit((current) => addSubtitles(current, cues));
  notify(`${cues.length} legendas criadas. Revise o texto, porque o reconhecimento pode errar palavras.`);
}

/** Cuts ranges from several clips; later clips go first, so earlier times stay valid. */
function cutFromClips(bySegment: Map<string, { start: number; end: number }[]>): void {
  edit((project) => {
    let next = project;
    for (const [segmentId, ranges] of [...bySegment].reverse()) {
      next = cutSourceRanges(next, segmentId, ranges);
    }
    return next;
  });
}

/** Cuts a stretch of consecutive words, with the short silences between them. */
export function cutWords(words: PlacedWord[]): void {
  const bySegment = new Map<string, { start: number; end: number }[]>();
  for (const { segmentId, start, end } of words) {
    const range = bySegment.get(segmentId)?.[0];
    bySegment.set(segmentId, [
      { start: Math.min(start, range?.start ?? start), end: Math.max(end, range?.end ?? end) },
    ]);
  }
  cutFromClips(bySegment);
}

export function cutHesitations(segmentId: string): void {
  const { project } = getState();
  const found = findSegment(project, segmentId);
  const hesitations = found ? trackWords(project, found.track.id).filter(isHesitation) : [];
  if (hesitations.length === 0) {
    notify("Não encontrei hesitações, como \"hum\" e \"ahn\", na transcrição.");
    return;
  }
  // Unlike a selected stretch, these are scattered, so only the words themselves go.
  const bySegment = new Map<string, { start: number; end: number }[]>();
  for (const { segmentId, start, end } of hesitations) {
    bySegment.set(segmentId, [...(bySegment.get(segmentId) ?? []), { start, end }]);
  }
  cutFromClips(bySegment);
  notify(`${hesitations.length} hesitação(ões) cortada(s).`);
}

export function fixWord(word: PlacedWord, text: string): void {
  edit((project) => {
    const materialId = findSegment(project, word.segmentId)?.segment.materialId;
    const pieces = project.tracks.flatMap((track) => track.segments).filter((item) => item.materialId === materialId);
    return pieces.reduce(
      (next, piece) => updateSegment(next, piece.id, (segment) => renameWord(segment, word.start, text)),
      project,
    );
  });
}

/** Makes the light copies still missing, one at a time, reusing those already on disk. */
async function prepareProxies(): Promise<void> {
  const videos = Object.values(getState().project.materials).filter(
    (material): material is MediaMaterial =>
      material.kind === "video" &&
      !material.offline &&
      Math.min(material.width, material.height) > PROXY_HEIGHT &&
      !pool.hasProxy(material.id),
  );
  for (const [index, material] of videos.entries()) {
    const label = videos.length > 1 ? `Criando versão leve ${index + 1}/${videos.length}` : "Criando versão leve";
    setState({ task: { label, progress: 0 } });
    const original = pool.blob(material.id);
    if (!original) continue;
    const copy =
      (await loadProxy(material.id)) ??
      (await makeProxy(material.id, original, (progress) => setState({ task: { label, progress } })));
    pool.addProxy(material.id, copy);
  }
}

export async function toggleLightPreview(): Promise<void> {
  const on = !getState().lightPreview;
  try {
    if (on) await prepareProxies();
    pool.useProxies = on;
    setState({ lightPreview: on });
  } catch (error) {
    notify(`Não foi possível criar a versão leve: ${(error as Error).message}`);
  } finally {
    setState({ task: null });
    void player.renderStill();
  }
}

const DUCK_AMOUNT = 0.7;
const DUCK_MIN_PAUSE_SECONDS = 0.6;

/** Finds where others are talking and lowers this clip there. */
export async function duckUnderSpeech(segmentId: string): Promise<void> {
  const { project } = getState();
  const found = findSegment(project, segmentId);
  if (!found) return;
  const voices = audibleClips()
    .filter((id) => id !== segmentId)
    .map((id) => findSegment(project, id)!.segment)
    .filter((segment) => segment.materialId !== found.segment.materialId);
  if (voices.length === 0) {
    notify("Adicione outro clipe com fala para a música abaixar sob ele.");
    return;
  }
  setState({ audioBusy: getState().audioBusy + 1 });
  const ranges: { start: number; end: number }[] = [];
  for (const voice of voices) {
    const pauses = (await findPauses(voice.materialId, voice.source, DUCK_MIN_PAUSE_SECONDS)) ?? [];
    const relative = pauses.map(({ start, end }) => ({
      start: (start - voice.source.start) / 1_000_000,
      end: (end - voice.source.start) / 1_000_000,
    }));
    for (const { start, end } of soundingRanges(relative, voice.source.duration / 1_000_000)) {
      ranges.push({
        start: Math.round(voice.target.start + (start * 1_000_000) / voice.speed - found.segment.target.start),
        end: Math.round(voice.target.start + (end * 1_000_000) / voice.speed - found.segment.target.start),
      });
    }
  }
  setState({ audioBusy: getState().audioBusy - 1 });
  const inside = ranges.filter(({ end, start }) => end > 0 && start < found.segment.target.duration);
  edit((current) =>
    updateSegment(current, segmentId, (segment) => {
      segment.ducking = { ranges: inside, amount: DUCK_AMOUNT };
    }),
  );
  notify(`Música abaixada em ${inside.length} trecho(s) de fala.`);
}

/** Cuts the videos on every second beat of this clip. */
export function cutVideoToBeats(segmentId: string): void {
  const { project } = getState();
  const found = findSegment(project, segmentId);
  const beats = found ? beatTimes(found.segment).filter((_, index) => index % 2 === 0) : [];
  if (beats.length === 0) {
    notify("Marque as batidas deste clipe primeiro.");
    return;
  }
  edit((current) => splitVideoAt(current, beats));
}

/** Every clip that makes sound, for normalizing a whole project. */
export function audibleClips(): string[] {
  const { project } = getState();
  return project.tracks.flatMap((track) =>
    track.muted
      ? []
      : track.segments
          .filter((segment) => {
            const material = project.materials[segment.materialId];
            return material && isMediaMaterial(material) && material.hasAudio && !material.offline && !segment.frozen;
          })
          .map((segment) => segment.id),
  );
}

/** Freezes the selected clip, or the topmost video under the playhead. */
export function freezeAtPlayhead(): void {
  const { selection, project, playhead } = getState();
  const underPlayhead = project.tracks
    .filter((track) => track.type === "video")
    .flatMap((track) => track.segments)
    .filter((segment) => segment.target.start <= playhead && segmentEnd(segment) > playhead)
    .at(-1);
  const target = selection ?? underPlayhead?.id;
  const frozen = target ? freezeFrame(project, target, playhead) : null;
  if (!frozen) {
    notify("Coloque o cursor sobre um clipe de vídeo para congelar o quadro.");
    return;
  }
  edit(() => frozen.project);
  setState({ selection: frozen.segmentId });
}

export function selectedOffset(): number {
  const { selection, project, playhead } = getState();
  const found = selection ? findSegment(project, selection) : null;
  if (!found) return 0;
  const { start, duration } = found.segment.target;
  return Math.min(Math.max(playhead - start, 0), duration);
}

export function stepFrames(frames: number): void {
  const { project, playhead } = getState();
  const next = playhead + (frames * 1_000_000) / project.fps;
  player.seek(Math.min(Math.max(0, Math.round(next)), projectDuration(project)));
}

/** Saves now what the delayed autosave would save, unless nothing was added. */
async function keepCurrent(): Promise<void> {
  const { project } = getState();
  if (Object.keys(project.materials).length) await saveProject(project);
}

/** Starts an empty project. The current one stays in the list of projects. */
export async function newProject(): Promise<void> {
  await keepCurrent();
  pool.clear();
  await removeProxies();
  resetProject(createProject());
  bumpMedia();
}

/** Loads a project's files into memory, marking as offline those that are gone. */
async function restoreProject(saved: Project): Promise<void> {
  for (const material of Object.values(saved.materials)) {
    if (!isMediaMaterial(material) || material.offline) continue;
    const blob = await loadMedia(material.id);
    if (blob) await pool.register(material.id, blob, material.kind);
    else material.offline = true;
  }
  for (const { id } of Object.values(saved.luts ?? {})) {
    const blob = await loadMedia(id);
    if (blob) await restoreLut(id, blob);
  }
  for (const { id, name } of Object.values(saved.fonts ?? {})) {
    const blob = await loadMedia(id);
    if (blob) await pool.addFont(id, name, blob).catch(() => undefined);
  }
  resetProject(saved);
  bumpMedia();
}

export { listProjects };

export async function switchProject(id: string): Promise<void> {
  if (id === getState().project.id) return;
  const saved = await loadProject(id);
  if (!saved) return;
  await keepCurrent();
  pool.clear();
  await removeProxies();
  await restoreProject(saved);
}

/** Deletes a project, and the files only it was using. */
export async function deleteProject(id: string): Promise<void> {
  await deleteSavedProject(id);
  const others = await Promise.all((await listProjects()).map(({ id: other }) => loadProject(other)));
  const projects = [...others, getState().project].filter((item) => item !== undefined);
  const used = new Set(
    projects.flatMap((project) => [
      ...Object.keys(project.materials),
      ...Object.keys(project.luts ?? {}),
      ...Object.keys(project.fonts ?? {}),
    ]),
  );
  for (const key of await storedMediaIds()) {
    if (!used.has(String(key))) await deleteMedia(String(key));
  }
}

/** Restores the autosaved project and reconnects its stored media. */
export async function boot(): Promise<void> {
  pool.onWaveform = bumpMedia;
  // An untouched project is not worth a place in the list.
  onSave((project: Project) => {
    if (Object.keys(project.materials).length) void saveProject(project);
  });
  const saved = await loadProject();
  if (saved) await restoreProject(saved);
}
