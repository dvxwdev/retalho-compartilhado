/**
 * The bridge an agent drives the editor through: window.retalho. It exposes
 * queries, plans of commands, rendering and export, and never the store
 * itself, so an agent edits only the way the commands allow. It is installed
 * only in development or when the build sets VITE_RETALHO_AUTOMATION to "1".
 */
import { ESQUEMA } from "../core/commandSchema";
import { executarPlano, inspecionar, validar, type Passo } from "../core/commands";
import { MAX_VOLUME, measureLoudness } from "../core/loudness";
import { SECOND, isMediaMaterial, projectDuration, type Project } from "../core/model";
import { formatSrt, subtitleCues } from "../core/subtitles";
import { exportAudio, exportProject, exportStill } from "../engine/exporter";
import { saveProject } from "../engine/persist";
import { buildProjectFile, newProject } from "./actions";
import { edit, getState, player, setState } from "./store";

const VERSAO = 1;
const DEFAULT_QUALITY = 0.2;
const SHEET_LABEL_HEIGHT = 0.08;

/** Files the agent reads back in pieces, so a large video never has to cross in one message. */
const arquivos = new Map<string, Blob>();
let proximoArquivo = 1;

function guardar(blob: Blob): { arquivo: string; tamanho: number; tipo: string } {
  const arquivo = `a${proximoArquivo++}`;
  arquivos.set(arquivo, blob);
  return { arquivo, tamanho: blob.size, tipo: blob.type };
}

async function lerArquivo(arquivo: string, inicio: number, fim: number): Promise<string> {
  const blob = arquivos.get(arquivo);
  if (!blob) throw new Error(`Arquivo desconhecido: ${arquivo}`);
  const bytes = new Uint8Array(await blob.slice(inicio, fim).arrayBuffer());
  let binario = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binario += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binario);
}

const pausa = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** Waits for background audio work and long tasks to finish, so what is read back is settled. */
async function esperar(limiteMs = 120_000): Promise<void> {
  const fim = performance.now() + limiteMs;
  // Edits schedule their audio work a moment later, so a quiet start is not yet the end.
  await pausa(400);
  while (getState().audioBusy > 0 || getState().task) {
    if (performance.now() > fim) throw new Error("O editor não terminou o processamento a tempo.");
    await pausa(100);
  }
}

function comandos() {
  return Object.fromEntries(
    Object.entries(ESQUEMA).map(([nome, { descricao, argumentos }]) => [
      nome,
      {
        descricao,
        argumentos: Object.fromEntries(
          Object.entries(argumentos).map(([arg, regra]) => [
            arg,
            {
              tipo: regra.tipo,
              ...(regra.obrigatorio ? { obrigatorio: true } : {}),
              ...(regra.anulavel ? { anulavel: true } : {}),
              ...(regra.valores ? { valores: [...regra.valores] } : {}),
              ...(regra.min !== undefined ? { min: regra.min } : {}),
              ...(regra.acimaDoMin ? { acimaDoMin: true } : {}),
              ...(regra.max !== undefined ? { max: regra.max } : {}),
            },
          ]),
        ),
      },
    ]),
  );
}

function midias() {
  const { project } = getState();
  return {
    materiais: Object.values(project.materials)
      .filter(isMediaMaterial)
      .map((material) => ({
        id: material.id,
        nome: material.name,
        tipo: material.kind,
        duracao: material.duration / SECOND,
        largura: material.width,
        altura: material.height,
        temAudio: material.hasAudio,
        offline: Boolean(material.offline),
      })),
    fontes: Object.values(project.fonts ?? {}).map(({ id, name }) => ({ id, nome: name })),
  };
}

interface OpcoesExecucao {
  simular?: boolean;
  falharAoPrimeiroErro?: boolean;
}

/** Runs a plan on a draft and, unless simulating, applies the result as one undo step. */
function executar(passos: Passo[], { simular = false, falharAoPrimeiroErro = true }: OpcoesExecucao = {}) {
  const { project } = getState();
  const resultado = executarPlano(project, passos, { falharAoPrimeiroErro });
  const aplicar = !simular && resultado.alterado && (resultado.ok || !falharAoPrimeiroErro);
  if (aplicar) edit(() => resultado.projeto);
  return {
    ok: resultado.ok,
    alterado: resultado.alterado,
    aplicado: aplicar,
    relatorio: resultado.relatorio,
    nomes: resultado.nomes,
    duracao: projectDuration(resultado.projeto) / SECOND,
  };
}

async function novo(nome?: string): Promise<void> {
  await newProject();
  if (nome) edit((project) => ({ ...project, name: nome }));
}

async function quadro(tempo: number): Promise<string> {
  await esperar();
  player.pause();
  const blob = await exportStill(getState().project, Math.round(tempo * SECOND));
  return paraDataUrl(blob);
}

async function paraDataUrl(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binario = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binario += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return `data:${blob.type || "image/png"};base64,${btoa(binario)}`;
}

interface OpcoesFolha {
  de?: number;
  ate?: number;
  passo?: number;
  colunas?: number;
  /** Width of each frame in the sheet, in pixels. */
  largura?: number;
}

/** A contact sheet: frames in a grid, each with its time, to look at a whole edit in one image. */
async function folha({ de = 0, ate, passo = 1, colunas = 6, largura = 240 }: OpcoesFolha = {}): Promise<string> {
  await esperar();
  player.pause();
  const { project } = getState();
  const fim = Math.min(ate ?? Infinity, projectDuration(project) / SECOND);
  const tempos: number[] = [];
  for (let tempo = de; tempo < fim - 1e-6 && tempos.length < 120; tempo += passo) tempos.push(Number(tempo.toFixed(3)));
  if (tempos.length === 0) throw new Error("Não há quadros nesse intervalo.");
  const altura = Math.round((largura * project.canvas.height) / project.canvas.width);
  const legenda = Math.max(18, Math.round(altura * SHEET_LABEL_HEIGHT));
  const linhas = Math.ceil(tempos.length / colunas);
  const canvas = new OffscreenCanvas(colunas * largura, linhas * (altura + legenda));
  const context = canvas.getContext("2d")!;
  context.fillStyle = "#111";
  context.fillRect(0, 0, canvas.width, canvas.height);
  for (const [index, tempo] of tempos.entries()) {
    const imagem = await createImageBitmap(await exportStill(project, Math.round(tempo * SECOND)));
    const x = (index % colunas) * largura;
    const y = Math.floor(index / colunas) * (altura + legenda);
    context.drawImage(imagem, x, y + legenda, largura, altura);
    imagem.close();
    context.fillStyle = "#ffd23f";
    context.font = `${Math.round(legenda * 0.7)}px sans-serif`;
    context.textBaseline = "middle";
    context.fillText(`${tempo.toFixed(1)} s`, x + 6, y + legenda / 2);
  }
  return paraDataUrl(await canvas.convertToBlob({ type: "image/jpeg", quality: 0.85 }));
}

/** Reads a 16-bit PCM WAV, as exportAudio writes it, into channels. */
function lerWav(buffer: ArrayBuffer): Float32Array[] {
  const view = new DataView(buffer);
  const canais = view.getUint16(22, true);
  let offset = 12;
  while (offset + 8 <= view.byteLength) {
    const id = String.fromCharCode(...new Uint8Array(buffer, offset, 4));
    const size = view.getUint32(offset + 4, true);
    if (id === "data") {
      const quadros = Math.floor(size / 2 / canais);
      const saida = Array.from({ length: canais }, () => new Float32Array(quadros));
      for (let quadro = 0; quadro < quadros; quadro += 1) {
        for (let canal = 0; canal < canais; canal += 1) {
          saida[canal]![quadro] = view.getInt16(offset + 8 + (quadro * canais + canal) * 2, true) / 32768;
        }
      }
      return saida;
    }
    offset += 8 + size + (size % 2);
  }
  throw new Error("WAV sem dados");
}

const paraDb = (valor: number) => (valor > 0 ? 20 * Math.log10(valor) : -Infinity);
const arredondar = (valor: number) => (Number.isFinite(valor) ? Math.round(valor * 10) / 10 : valor);

/** Loudness of the whole mix, as it would be exported. */
async function medirAudio(): Promise<{ lufs: number; picoDb: number }> {
  await esperar();
  const wav = await exportAudio(getState().project);
  const { loudness, peak } = measureLoudness(lerWav(await wav.arrayBuffer()));
  return { lufs: arredondar(loudness), picoDb: arredondar(paraDb(peak)) };
}

/** Clips that make sound in the mix: audio clips and videos with sound. */
function clipesComSom(project: Project): string[] {
  const ids: string[] = [];
  for (const track of project.tracks) {
    if (track.muted || track.locked) continue;
    for (const segment of track.segments) {
      const material = project.materials[segment.materialId];
      const temSom = material && isMediaMaterial(material) && (material.kind === "audio" || (material.kind === "video" && material.hasAudio));
      if (temSom && segment.volume > 0 && !segment.frozen) ids.push(segment.id);
    }
  }
  return ids;
}

interface OpcoesNormalizar {
  /** LUFS the mix should reach; -14 suits Reels, TikTok and YouTube. */
  alvo?: number;
  /** Highest peak allowed, in dBFS. */
  picoMax?: number;
}

/**
 * Brings the whole mix to a loudness by scaling every sounding clip by the same
 * amount, so the balance between voice and music stays as edited. A compressor
 * on a clip makes the result drift a little, so it measures again and corrects once.
 */
async function normalizarAudio({ alvo = -14, picoMax = -1 }: OpcoesNormalizar = {}) {
  const antes = await medirAudio();
  let atual = antes;
  let ganhoTotal = 1;
  for (let tentativa = 0; tentativa < 3; tentativa += 1) {
    if (!Number.isFinite(atual.lufs)) throw new Error("O projeto não tem som para normalizar.");
    const porLoudness = 10 ** ((alvo - atual.lufs) / 20);
    const porPico = 10 ** ((picoMax - atual.picoDb) / 20);
    const ganho = Math.min(porLoudness, porPico);
    if (Math.abs(paraDb(ganho)) < 0.2) break;
    const ids = new Set(clipesComSom(getState().project));
    edit((project) => ({
      ...project,
      tracks: project.tracks.map((track) => ({
        ...track,
        segments: track.segments.map((segment) =>
          ids.has(segment.id) ? { ...segment, volume: Math.min(MAX_VOLUME, segment.volume * ganho) } : segment,
        ),
      })),
    }));
    ganhoTotal *= ganho;
    atual = await medirAudio();
  }
  return { antes, depois: atual, ganhoDb: arredondar(paraDb(ganhoTotal)) };
}

interface OpcoesExportar {
  formato?: "mp4" | "wav" | "png" | "srt" | "retalho";
  /** Bits per pixel per frame, as in the export dialog: 0.2 high, 0.12 medium, 0.07 light. */
  qualidade?: number;
  /** Short side in pixels; 0 keeps the project size. */
  lado?: number;
  fps?: number;
  desfoque?: boolean;
  /** For png, the time of the frame. */
  tempo?: number;
}

let progresso = 0;

async function exportar({ formato = "mp4", qualidade = DEFAULT_QUALITY, lado = 0, fps, desfoque = false, tempo = 0 }: OpcoesExportar = {}) {
  await esperar();
  player.pause();
  const { project } = getState();
  progresso = 0;
  const inicio = performance.now();
  let blob: Blob;
  let detalhe = formato.toUpperCase();
  if (formato === "wav") blob = await exportAudio(project);
  else if (formato === "png") blob = await exportStill(project, Math.round(tempo * SECOND));
  else if (formato === "srt") blob = new Blob([formatSrt(subtitleCues(project))], { type: "application/x-subrip" });
  else if (formato === "retalho") blob = buildProjectFile();
  else {
    const resultado = await exportProject(project, {
      quality: qualidade,
      shortSide: lado,
      fps: fps ?? project.fps,
      motionBlur: desfoque,
      signal: new AbortController().signal,
      onProgress: (fracao) => {
        progresso = fracao;
      },
    });
    blob = resultado.blob;
    detalhe = [resultado.videoCodec, resultado.audioCodec].filter(Boolean).join(" + ").toUpperCase();
  }
  void player.renderStill();
  progresso = 1;
  return { ...guardar(blob), detalhe, segundos: Math.round((performance.now() - inicio) / 100) / 10 };
}

export interface RetalhoAutomacao {
  versao: number;
  comandos: typeof comandos;
  midias: typeof midias;
  inspecionar(): ReturnType<typeof inspecionar>;
  validar(): ReturnType<typeof validar>;
  executar: typeof executar;
  novo: typeof novo;
  esperar: typeof esperar;
  quadro: typeof quadro;
  folha: typeof folha;
  medirAudio: typeof medirAudio;
  normalizarAudio: typeof normalizarAudio;
  exportar: typeof exportar;
  progresso(): number;
  lerArquivo: typeof lerArquivo;
  liberarArquivo(arquivo: string): void;
  estado(): { tarefa: string | null; audioOcupado: number; aviso: string | null };
  limparAviso(): void;
  /** Saves the project to the browser now, instead of after the autosave delay. */
  gravar(): Promise<void>;
}

export function installAutomation(): void {
  const api: RetalhoAutomacao = {
    versao: VERSAO,
    comandos,
    midias,
    inspecionar: () => inspecionar(getState().project),
    validar: () => validar(getState().project),
    executar,
    novo,
    esperar,
    quadro,
    folha,
    medirAudio,
    normalizarAudio,
    exportar,
    progresso: () => progresso,
    lerArquivo,
    liberarArquivo: (arquivo) => void arquivos.delete(arquivo),
    estado: () => {
      const { task, audioBusy, notice } = getState();
      return { tarefa: task?.label ?? null, audioOcupado: audioBusy, aviso: notice?.text ?? null };
    },
    limparAviso: () => setState({ notice: null }),
    gravar: async () => {
      const { project } = getState();
      if (Object.keys(project.materials).length) await saveProject(project);
    },
  };
  Object.defineProperty(window, "retalho", { value: Object.freeze(api), configurable: false, writable: false });
}
