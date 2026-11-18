import type { EntranceType } from "./animation";
import { ESQUEMA, conferirArgumentos, conferirEstilo, invalido } from "./commandSchema";
import type { CurveChannel, CurvePoint, HslColor, HslShift } from "./curves";
import { sampleProp, upsertKeyframe, writeBase } from "./keyframes";
import { EFFECT_TYPES, type Chroma, type EffectType } from "./look";
import {
  ANIMATABLE,
  SECOND,
  findSegment,
  frameDuration,
  newId,
  projectDuration,
  segmentEnd,
  trackTypeFor,
  type AnimatableProp,
  type Analise,
  type AudioEffects,
  type ClipFrame,
  type Crop,
  type Easing,
  type Fit,
  type ShapeKind,
  type TextMaterial,
  type KeyedProp,
  type Keyframe,
  type Marker,
  type Mask,
  type Material,
  type Project,
  type Segment,
  type Track,
  type TrackType,
  type Us,
} from "./model";
import {
  MARKER_COLOR,
  addShapeMaterial,
  addTextMaterial,
  addTrack,
  makeSegment,
  nearestFreeStart,
  updateTrack,
  cutSourceRanges,
  deleteSegment,
  duplicateSegment,
  freezeFrame,
  groupMembers,
  moveSegment,
  placeMaterial,
  removeMarker,
  replaceInTexts,
  setCropEdge,
  setEasing,
  setProp,
  setSpeed,
  shiftSegments,
  splitSegment,
  trimEnd,
  trimStart,
  updateMaterial,
  updateSegment,
} from "./ops";
import { PAUSE_MARGIN_SECONDS } from "./pauses";
import { isHesitation, trackWords, wordsToCues, type PlacedWord, type Word } from "./speech";
import { addSubtitles } from "./subtitles";

/**
 * Editing as named commands: a project and arguments in, a result out. Nothing
 * here touches the browser, the interface or storage. The operations in ops.ts
 * return the project unchanged without saying why, so each command checks first
 * and answers with the right code. Times are seconds, on the timeline unless a
 * command says they are source time.
 */
export type CodigoErro =
  | "COMANDO_DESCONHECIDO"
  | "ARGUMENTO_INVALIDO"
  | "CLIPE_NAO_ENCONTRADO"
  | "MATERIAL_NAO_ENCONTRADO"
  | "FAIXA_BLOQUEADA"
  | "SOBREPOSICAO"
  | "CORTE_MUITO_CURTO"
  | "CORTE_FORA_DO_CLIPE"
  | "FORA_DA_FONTE"
  | "TIPO_DE_FAIXA_INCOMPATIVEL"
  | "PROPRIEDADE_NAO_SUPORTADA";

export type Falha = { ok: false; codigo: CodigoErro; mensagem: string; detalhes?: unknown };

export type Resultado =
  | { ok: true; projeto: Project; alterado: boolean; afetados: string[]; avisos: string[] }
  | Falha;

type Args = Record<string, unknown>;
type Achado = NonNullable<ReturnType<typeof findSegment>>;

const PAUSA_MINIMA_SEGUNDOS = 0.5;
const ADJUST_LIMITS: Record<string, [number, number]> = {
  brightness: [-100, 100],
  contrast: [-100, 100],
  saturation: [-100, 100],
  exposure: [-100, 100],
  temperature: [-100, 100],
  tint: [-100, 100],
  hue: [-100, 100],
  highlights: [-100, 100],
  shadows: [-100, 100],
  vignette: [-100, 100],
  sharpen: [0, 100],
  grain: [0, 100],
  fade: [0, 100],
};

const paraUs = (segundos: number): Us => Math.round(segundos * SECOND);
const paraSegundos = (tempo: Us): number => tempo / SECOND;

/** The nearest frame, on the same grid the export draws: frame n is at n / fps. */
function paraQuadro(projeto: Project, tempo: Us): Us {
  return Math.round((Math.round((tempo * projeto.fps) / SECOND) * SECOND) / projeto.fps);
}

function falha(codigo: CodigoErro, mensagem: string, detalhes?: unknown): Falha {
  return { ok: false, codigo, mensagem, ...(detalhes === undefined ? {} : { detalhes }) };
}

const isFalha = (valor: object): valor is Falha => "ok" in valor && valor.ok === false;

/** Everything with an id, so a result can say what changed without each command tracking it. */
function indice(projeto: Project): Map<string, unknown> {
  const itens = new Map<string, unknown>();
  for (const track of projeto.tracks) {
    itens.set(track.id, { ...track, segments: track.segments.map((segment) => segment.id) });
    for (const segment of track.segments) itens.set(segment.id, segment);
  }
  for (const material of Object.values(projeto.materials)) itens.set(material.id, material);
  for (const marker of projeto.markers ?? []) itens.set(marker.id, marker);
  return itens;
}

/** New ids come first, so a command that creates something names it at the start of the list. */
function concluir(antes: Project, depois: Project, avisos: string[] = []): Resultado {
  if (antes === depois) return { ok: true, projeto: antes, alterado: false, afetados: [], avisos };
  const velhos = indice(antes);
  const novos = indice(depois);
  const criados: string[] = [];
  const mudados: string[] = [];
  for (const [id, item] of novos) {
    if (!velhos.has(id)) criados.push(id);
    else if (JSON.stringify(velhos.get(id)) !== JSON.stringify(item)) mudados.push(id);
  }
  for (const id of velhos.keys()) if (!novos.has(id)) mudados.push(id);
  const afetados = [...criados, ...mudados];
  if (afetados.length === 0) return { ok: true, projeto: antes, alterado: false, afetados, avisos };
  return { ok: true, projeto: depois, alterado: true, afetados, avisos };
}

function localizar(projeto: Project, clipeId: string): Achado | Falha {
  const achado = findSegment(projeto, clipeId);
  if (!achado) return falha("CLIPE_NAO_ENCONTRADO", `Clipe não encontrado: ${clipeId}`);
  return achado;
}

/** The clip, as long as its track accepts edits. */
function editavel(projeto: Project, clipeId: string): Achado | Falha {
  const achado = localizar(projeto, clipeId);
  if (isFalha(achado)) return achado;
  if (achado.track.locked) return falha("FAIXA_BLOQUEADA", `A faixa "${achado.track.name}" está bloqueada.`);
  return achado;
}

function conferirFaixa(projeto: Project, faixaId: string | undefined, tipo: TrackType): Falha | null {
  if (faixaId === undefined) return null;
  const faixa = projeto.tracks.find((track) => track.id === faixaId);
  if (!faixa) return falha("ARGUMENTO_INVALIDO", invalido("faixaId", faixaId, "id de uma faixa do projeto"));
  if (faixa.locked) return falha("FAIXA_BLOQUEADA", `A faixa "${faixa.name}" está bloqueada.`);
  if (faixa.type !== tipo) {
    return falha("TIPO_DE_FAIXA_INCOMPATIVEL", `A faixa é de ${faixa.type}, e o clipe precisa de uma faixa de ${tipo}.`);
  }
  return null;
}

const materialDe = (projeto: Project, segment: Segment): Material | undefined => projeto.materials[segment.materialId];

/** The same rules the panel uses to decide which pages a clip has. */
function isVisual({ track, segment }: Achado, projeto: Project): boolean {
  return track.type !== "audio" && materialDe(projeto, segment)?.kind !== "adjustment";
}

function temVisual({ track, segment }: Achado, projeto: Project): boolean {
  return track.type === "video" || materialDe(projeto, segment)?.kind === "adjustment";
}

function temFonte({ segment }: Achado, projeto: Project): boolean {
  const kind = materialDe(projeto, segment)?.kind;
  return kind === "video" || kind === "audio";
}

const naoSuportada = (o: string) => falha("PROPRIEDADE_NAO_SUPORTADA", `Este clipe não aceita ${o}.`);

function conferirPropriedade(achado: Achado, projeto: Project, propriedade: string, valor?: number): Falha | null {
  const isTransform = (ANIMATABLE as readonly string[]).includes(propriedade);
  const isEfeito = (EFFECT_TYPES as readonly string[]).includes(propriedade);
  const limites = ADJUST_LIMITS[propriedade];
  if (!isTransform && !isEfeito && !limites) return naoSuportada(`a propriedade ${propriedade}`);
  if (isTransform ? !isVisual(achado, projeto) : !temVisual(achado, projeto)) {
    return naoSuportada(`a propriedade ${propriedade}`);
  }
  if (valor === undefined) return null;
  const [min, max] = isEfeito
    ? [0, 1]
    : (limites ?? (propriedade === "opacity" ? [0, 1] : [-Infinity, Infinity]));
  if (valor < min || valor > max || (propriedade === "scale" && valor <= 0)) {
    const aceito = propriedade === "scale" ? "número maior que 0" : `número de ${min} a ${max}`;
    return falha("ARGUMENTO_INVALIDO", invalido("valor", valor, `${aceito} para ${propriedade}`));
  }
  return null;
}

/** A timeline time as an offset into the clip, which it has to fall inside. */
function deslocamento({ segment }: Achado, tempo: number): Us | Falha {
  const offset = paraUs(tempo) - segment.target.start;
  if (offset < 0 || offset > segment.target.duration) {
    const inicio = paraSegundos(segment.target.start);
    const fim = paraSegundos(segmentEnd(segment));
    return falha("ARGUMENTO_INVALIDO", invalido("tempo", tempo, `tempo dentro do clipe, de ${inicio} a ${fim}`), { inicio, fim });
  }
  return offset;
}

const aviso = (o: string, pedido: Us, efetivo: Us) =>
  `${o}: pedido ${paraSegundos(pedido)}, efetivo ${paraSegundos(efetivo)}.`;

function adicionarClipe(projeto: Project, args: Args): Resultado {
  const materialId = args.materialId as string;
  const faixaId = args.faixaId as string | undefined;
  const material = projeto.materials[materialId];
  if (!material) return falha("MATERIAL_NAO_ENCONTRADO", `Material não encontrado: ${materialId}`);
  const erro = conferirFaixa(projeto, faixaId, trackTypeFor(material));
  if (erro) return erro;
  const wanted = paraUs(args.inicio as number);
  const placed = placeMaterial(projeto, materialId, wanted, faixaId);
  const { segmentId } = placed;
  let project = placed.project;
  const avisos: string[] = [];
  if (args.duracao !== undefined || args.inicioFonte !== undefined) {
    const total = material.kind === "video" || material.kind === "audio" ? material.duration : null;
    let sourceStart: Us = 0;
    let duration = args.duracao === undefined ? null : paraUs(args.duracao as number);
    if (total === null) {
      if (args.inicioFonte !== undefined) avisos.push("Este material não tem fonte com tempo, então inicioFonte foi ignorado.");
    } else {
      const pedido = paraUs((args.inicioFonte as number | undefined) ?? 0);
      sourceStart = Math.min(pedido, Math.max(0, total - frameDuration(projeto)));
      if (sourceStart !== pedido) avisos.push(aviso("Início da fonte limitado ao fim do material", pedido, sourceStart));
      const cabe = total - sourceStart;
      if (duration === null || duration > cabe) {
        if (duration !== null) avisos.push(aviso("Duração limitada ao que resta da fonte", duration, cabe));
        duration = cabe;
      }
    }
    project = updateSegment(project, segmentId, (segment) => {
      segment.source.start = sourceStart;
      if (duration !== null) {
        segment.source.duration = duration;
        segment.target.duration = duration;
      }
    });
    // The clip was placed at its default length, so its place is settled once it has the real one.
    const { track } = findSegment(project, segmentId)!;
    project = moveSegment(project, segmentId, wanted, track.id);
  }
  const inicio = findSegment(project, segmentId)!.segment.target.start;
  if (inicio !== wanted) avisos.push(aviso("Início ajustado ao espaço livre", wanted, inicio));
  return concluir(projeto, project, avisos);
}

/** Slides a whole group in time. A group spans tracks, so it stays on them, and it moves whole or not at all. */
function moverGrupo(projeto: Project, achado: Achado, membros: string[], wanted: Us, faixaId: string): Resultado {
  if (faixaId !== achado.track.id) {
    return falha("ARGUMENTO_INVALIDO", invalido("faixaId", faixaId, `a faixa atual do clipe (${achado.track.id}), ou apenasClipe: true para mudar de faixa`));
  }
  const clipes = membros.map((id) => findSegment(projeto, id)!);
  const bloqueada = clipes.find(({ track }) => track.locked);
  if (bloqueada) return falha("FAIXA_BLOQUEADA", `A faixa "${bloqueada.track.name}" está bloqueada.`);
  const primeiro = Math.min(...clipes.map(({ segment }) => segment.target.start));
  const delta = Math.max(wanted - achado.segment.target.start, -primeiro);
  const conflitos = new Set<string>();
  for (const { track, segment } of clipes) {
    for (const outro of track.segments) {
      if (membros.includes(outro.id)) continue;
      if (segment.target.start + delta < segmentEnd(outro) && segmentEnd(segment) + delta > outro.target.start) conflitos.add(outro.id);
    }
  }
  if (conflitos.size) {
    return falha("SOBREPOSICAO", "O grupo colidiria com outros clipes, e nada foi movido.", { conflitos: [...conflitos] });
  }
  const depois = shiftSegments(projeto, membros, delta);
  const inicio = findSegment(depois, achado.segment.id)!.segment.target.start;
  return concluir(projeto, depois, inicio === wanted ? [] : [aviso("Grupo limitado ao começo da timeline", wanted, inicio)]);
}

function moverClipe(projeto: Project, args: Args): Resultado {
  const clipeId = args.clipeId as string;
  const achado = editavel(projeto, clipeId);
  if (isFalha(achado)) return achado;
  const faixaId = (args.faixaId as string | undefined) ?? achado.track.id;
  const erro = conferirFaixa(projeto, faixaId, achado.track.type);
  if (erro) return erro;
  const wanted = paraUs(args.inicio as number);
  const membros = args.apenasClipe ? [clipeId] : groupMembers(projeto, clipeId);
  if (membros.length > 1) return moverGrupo(projeto, achado, membros, wanted, faixaId);
  const depois = moveSegment(projeto, clipeId, wanted, faixaId);
  const inicio = findSegment(depois, clipeId)!.segment.target.start;
  return concluir(projeto, depois, inicio === wanted ? [] : [aviso("Início ajustado ao espaço livre", wanted, inicio)]);
}

function aparar(projeto: Project, args: Args): Resultado {
  const clipeId = args.clipeId as string;
  const achado = editavel(projeto, clipeId);
  if (isFalha(achado)) return achado;
  const { segment } = achado;
  const wanted = paraUs(args.tempo as number);
  const frame = frameDuration(projeto);
  const noInicio = args.lado === "inicio";
  if (noInicio ? wanted > segmentEnd(segment) - frame : wanted < segment.target.start + frame) {
    return falha("CORTE_MUITO_CURTO", "O clipe ficaria com menos de um quadro.");
  }
  const depois = noInicio ? trimStart(projeto, clipeId, wanted) : trimEnd(projeto, clipeId, wanted);
  const final = findSegment(depois, clipeId)!.segment;
  const efetivo = noInicio ? final.target.start : segmentEnd(final);
  return concluir(projeto, depois, efetivo === wanted ? [] : [aviso("Borda limitada pela fonte ou pelo clipe vizinho", wanted, efetivo)]);
}

function dividir(projeto: Project, args: Args): Resultado {
  const clipeId = args.clipeId as string;
  const achado = editavel(projeto, clipeId);
  if (isFalha(achado)) return achado;
  const { segment } = achado;
  const pedido = paraUs(args.tempo as number);
  if (pedido < segment.target.start || pedido > segmentEnd(segment)) {
    return falha("CORTE_FORA_DO_CLIPE", `O tempo ${args.tempo as number} está fora do clipe.`, {
      inicio: paraSegundos(segment.target.start),
      fim: paraSegundos(segmentEnd(segment)),
    });
  }
  const at = paraQuadro(projeto, pedido);
  const dividido = splitSegment(projeto, clipeId, at);
  if (!dividido) return falha("CORTE_MUITO_CURTO", "Uma das partes ficaria com menos de um quadro.");
  return concluir(projeto, dividido.project, at === pedido ? [] : [aviso("Tempo alinhado ao quadro", pedido, at)]);
}

function excluir(projeto: Project, args: Args): Resultado {
  const clipeId = args.clipeId as string;
  const achado = editavel(projeto, clipeId);
  if (isFalha(achado)) return achado;
  return concluir(projeto, deleteSegment(projeto, clipeId, Boolean(args.fecharEspaco)));
}

function duplicar(projeto: Project, args: Args): Resultado {
  const clipeId = args.clipeId as string;
  const achado = editavel(projeto, clipeId);
  if (isFalha(achado)) return achado;
  const copia = duplicateSegment(projeto, clipeId);
  if (!copia) return falha("MATERIAL_NAO_ENCONTRADO", `O material do clipe não existe: ${achado.segment.materialId}`);
  return concluir(projeto, copia.project);
}

function definirVelocidade(projeto: Project, args: Args): Resultado {
  const clipeId = args.clipeId as string;
  const achado = editavel(projeto, clipeId);
  if (isFalha(achado)) return achado;
  if (!temFonte(achado, projeto) || achado.segment.frozen) return naoSuportada("mudança de velocidade");
  return concluir(projeto, setSpeed(projeto, clipeId, args.velocidade as number));
}

function congelarQuadro(projeto: Project, args: Args): Resultado {
  const clipeId = args.clipeId as string;
  const achado = editavel(projeto, clipeId);
  if (isFalha(achado)) return achado;
  const { segment } = achado;
  if (materialDe(projeto, segment)?.kind !== "video" || segment.frozen) return naoSuportada("congelar quadro");
  const at = paraUs(args.tempo as number);
  if (at < segment.target.start || at >= segmentEnd(segment)) {
    return falha("CORTE_FORA_DO_CLIPE", `O tempo ${args.tempo as number} está fora do clipe.`);
  }
  const duracao = args.duracao === undefined ? undefined : paraUs(args.duracao as number);
  const { project, segmentId } = freezeFrame(projeto, clipeId, at, duracao)!;
  const inicio = findSegment(project, segmentId)!.segment.target.start;
  return concluir(projeto, project, inicio === at ? [] : [aviso("Quadro colocado na borda do clipe", at, inicio)]);
}

function definirPropriedade(projeto: Project, args: Args): Resultado {
  const clipeId = args.clipeId as string;
  const achado = editavel(projeto, clipeId);
  if (isFalha(achado)) return achado;
  const propriedade = args.propriedade as KeyedProp;
  const valor = args.valor as number;
  const erro = conferirPropriedade(achado, projeto, propriedade, valor);
  if (erro) return erro;
  const animada = Boolean(achado.segment.keyframes[propriedade]?.length);
  const tempo = args.tempo as number | undefined;
  if (animada && tempo === undefined) {
    return falha("ARGUMENTO_INVALIDO", invalido("tempo", undefined, `número, porque a propriedade ${propriedade} é animada`));
  }
  if (!animada) {
    const avisos = tempo === undefined ? [] : [`A propriedade ${propriedade} não é animada, então o tempo foi ignorado.`];
    return concluir(projeto, setProp(projeto, clipeId, propriedade, valor, 0), avisos);
  }
  const offset = deslocamento(achado, tempo!);
  if (typeof offset !== "number") return offset;
  return concluir(projeto, setProp(projeto, clipeId, propriedade, valor, offset));
}

/** Distinct keyframe times of a clip, on the timeline, in seconds. */
function temposDeKeyframe(segment: Segment, keyframes: (Keyframe | undefined)[]): number[] {
  const offsets = new Set(keyframes.map((keyframe) => keyframe!.offset));
  return [...offsets].sort((a, b) => a - b).map((offset) => paraSegundos(segment.target.start + offset));
}

function definirKeyframe(projeto: Project, args: Args): Resultado {
  const clipeId = args.clipeId as string;
  const achado = editavel(projeto, clipeId);
  if (isFalha(achado)) return achado;
  const propriedade = args.propriedade as KeyedProp;
  const erro = conferirPropriedade(achado, projeto, propriedade, args.valor as number | undefined);
  if (erro) return erro;
  const offset = deslocamento(achado, args.tempo as number);
  if (typeof offset !== "number") return offset;
  const existia = achado.segment.keyframes[propriedade]?.some((keyframe) => keyframe.offset === offset);
  const valor = (args.valor as number | undefined) ?? sampleProp(achado.segment, propriedade, offset);
  const avisos = existia ? [`O keyframe de ${propriedade} em ${args.tempo as number} já existia e foi atualizado para ${valor}.`] : [];
  const depois = updateSegment(projeto, clipeId, (segment) => {
    segment.keyframes[propriedade] = upsertKeyframe(segment.keyframes[propriedade] ?? [], offset, valor);
  });
  return concluir(projeto, depois, avisos);
}

function removerKeyframe(projeto: Project, args: Args): Resultado {
  const clipeId = args.clipeId as string;
  const achado = editavel(projeto, clipeId);
  if (isFalha(achado)) return achado;
  const propriedade = args.propriedade as KeyedProp;
  const erro = conferirPropriedade(achado, projeto, propriedade);
  if (erro) return erro;
  const { segment } = achado;
  const offset = paraUs(args.tempo as number) - segment.target.start;
  const keyframes = segment.keyframes[propriedade] ?? [];
  if (!keyframes.some((keyframe) => keyframe.offset === offset)) {
    const tempos = temposDeKeyframe(segment, keyframes);
    const aceito = tempos.length ? `um tempo com keyframe de ${propriedade}: ${tempos.join(", ")}` : `um tempo com keyframe, mas ${propriedade} não tem nenhum`;
    return falha("ARGUMENTO_INVALIDO", invalido("tempo", args.tempo, aceito), { tempos });
  }
  const valor = sampleProp(segment, propriedade, offset);
  return concluir(
    projeto,
    updateSegment(projeto, clipeId, (item) => {
      const restantes = keyframes.filter((keyframe) => keyframe.offset !== offset);
      if (restantes.length) {
        item.keyframes[propriedade] = restantes;
      } else {
        // Without keyframes the property holds still, at the value it had here.
        delete item.keyframes[propriedade];
        writeBase(item, propriedade, valor);
      }
    }),
  );
}

function definirSuavizacao(projeto: Project, args: Args): Resultado {
  const clipeId = args.clipeId as string;
  const achado = editavel(projeto, clipeId);
  if (isFalha(achado)) return achado;
  const keyframes = Object.values(achado.segment.keyframes).flat();
  if (keyframes.length === 0) return concluir(projeto, projeto, ["O clipe não tem keyframes."]);
  const suavizacao = args.suavizacao as Easing | null;
  if (args.tempo === undefined) return concluir(projeto, setEasing(projeto, clipeId, suavizacao));
  const offset = deslocamento(achado, args.tempo as number);
  if (typeof offset !== "number") return offset;
  if (!keyframes.some((keyframe) => keyframe!.offset === offset)) {
    const tempos = temposDeKeyframe(achado.segment, keyframes);
    return falha("ARGUMENTO_INVALIDO", invalido("tempo", args.tempo, `um tempo com keyframe: ${tempos.join(", ")}`), { tempos });
  }
  return concluir(projeto, setEasing(projeto, clipeId, suavizacao, offset));
}

function definirRecorte(projeto: Project, args: Args): Resultado {
  const clipeId = args.clipeId as string;
  const achado = editavel(projeto, clipeId);
  if (isFalha(achado)) return achado;
  if (achado.track.type !== "video") return naoSuportada("recorte");
  const borda = args.borda as keyof Crop;
  const valor = args.valor as number;
  const depois = setCropEdge(projeto, clipeId, borda, valor);
  const efetivo = findSegment(depois, clipeId)!.segment.crop?.[borda] ?? 0;
  return concluir(projeto, depois, efetivo === valor ? [] : [`Recorte limitado pela borda oposta: pedido ${valor}, efetivo ${Number(efetivo.toFixed(6))}.`]);
}

function adicionarTexto(projeto: Project, args: Args): Resultado {
  const faixaId = args.faixaId as string | undefined;
  const erro = conferirFaixa(projeto, faixaId, "text");
  if (erro) return erro;
  const wanted = paraUs(args.inicio as number);
  const duration = paraUs(args.duracao as number);
  const { project, materialId } = addTextMaterial(projeto, args.texto as string);
  const { project: colocado, segmentId } = placeMaterial(project, materialId, wanted, faixaId);
  const medido = updateSegment(colocado, segmentId, (segment) => {
    segment.target.duration = duration;
    segment.source.duration = duration;
  });
  // A text starts at a default length, so its place is settled once it has the real one.
  const { track } = findSegment(medido, segmentId)!;
  const depois = moveSegment(medido, segmentId, wanted, track.id);
  const inicio = findSegment(depois, segmentId)!.segment.target.start;
  return concluir(projeto, depois, inicio === wanted ? [] : [aviso("Início ajustado ao espaço livre", wanted, inicio)]);
}

const faixasDoMaterial = (projeto: Project, materialId: string): Track[] =>
  projeto.tracks.filter((track) => track.segments.some((segment) => segment.materialId === materialId));

function definirTexto(projeto: Project, args: Args): Resultado {
  const { clipeId, materialId } = args as { clipeId?: string; materialId?: string };
  if ((clipeId === undefined) === (materialId === undefined)) {
    return falha("ARGUMENTO_INVALIDO", invalido("materialId", materialId, "materialId ou clipeId, só um dos dois"));
  }
  let id = materialId;
  if (clipeId !== undefined) {
    const achado = localizar(projeto, clipeId);
    if (isFalha(achado)) return achado;
    id = achado.segment.materialId;
  }
  const material = projeto.materials[id!];
  if (!material) return falha("MATERIAL_NAO_ENCONTRADO", `Material não encontrado: ${id!}`);
  if (material.kind !== "text") return naoSuportada("texto");
  const bloqueada = faixasDoMaterial(projeto, id!).find((track) => track.locked);
  if (bloqueada) return falha("FAIXA_BLOQUEADA", `A faixa "${bloqueada.name}" está bloqueada.`);
  return concluir(projeto, updateMaterial(projeto, id!, { text: args.texto as string }));
}

function substituirTexto(projeto: Project, args: Args): Resultado {
  const de = args.de as string;
  for (const material of Object.values(projeto.materials)) {
    if (material.kind !== "text" || !material.text.includes(de)) continue;
    const bloqueada = faixasDoMaterial(projeto, material.id).find((track) => track.locked);
    if (bloqueada) return falha("FAIXA_BLOQUEADA", `A faixa "${bloqueada.name}" está bloqueada.`);
  }
  return concluir(projeto, replaceInTexts(projeto, de, args.para as string).project);
}

function definirVolume(projeto: Project, args: Args): Resultado {
  const clipeId = args.clipeId as string;
  const achado = editavel(projeto, clipeId);
  if (isFalha(achado)) return achado;
  if (!temFonte(achado, projeto)) return naoSuportada("volume");
  const material = materialDe(projeto, achado.segment);
  const avisos = material && "hasAudio" in material && !material.hasAudio ? ["Este vídeo não tem som."] : [];
  const volume = args.volume as number;
  return concluir(projeto, updateSegment(projeto, clipeId, (segment) => void (segment.volume = volume)), avisos);
}

function cortarTrechos(projeto: Project, args: Args): Resultado {
  const clipeId = args.clipeId as string;
  const achado = editavel(projeto, clipeId);
  if (isFalha(achado)) return achado;
  const { segment } = achado;
  if (!temFonte(achado, projeto) || segment.frozen || segment.reversed) return naoSuportada("corte por tempo da fonte");
  const inicio = segment.source.start;
  const fim = inicio + segment.source.duration;
  const avisos: string[] = [];
  const trechos: { start: Us; end: Us }[] = [];
  for (const trecho of args.trechos as { inicio: number; fim: number }[]) {
    const pedido = { start: paraUs(trecho.inicio), end: paraUs(trecho.fim) };
    const start = Math.max(pedido.start, inicio);
    const end = Math.min(pedido.end, fim);
    if (end <= start) {
      return falha("CORTE_FORA_DO_CLIPE", `O trecho ${trecho.inicio}-${trecho.fim} está fora do clipe.`, {
        inicio: paraSegundos(inicio),
        fim: paraSegundos(fim),
      });
    }
    if (start !== pedido.start || end !== pedido.end) {
      avisos.push(`Trecho limitado ao clipe: pedido ${trecho.inicio}-${trecho.fim}, efetivo ${paraSegundos(start)}-${paraSegundos(end)}.`);
    }
    trechos.push({ start, end });
  }
  return concluir(projeto, cutSourceRanges(projeto, clipeId, trechos), avisos);
}

function marcar(projeto: Project, args: Args): Resultado {
  const time = paraUs(args.tempo as number);
  const marcadores = projeto.markers ?? [];
  const noQuadro = marcadores.find((marker) => Math.abs(marker.time - time) <= frameDuration(projeto) / 2);
  if (noQuadro) return concluir(projeto, projeto, [`Já existe o marcador "${noQuadro.label}" nesse quadro, em ${paraSegundos(noQuadro.time)}.`]);
  const numeros = marcadores.map((marker) => Number(/(\d+)$/.exec(marker.label)?.[1] ?? 0));
  const novo: Marker = {
    id: newId(),
    time,
    label: (args.rotulo as string | undefined) ?? `Marcador ${String(Math.max(0, ...numeros) + 1).padStart(2, "0")}`,
    color: MARKER_COLOR,
  };
  return concluir(projeto, { ...projeto, markers: [...marcadores, novo].sort((a, b) => a.time - b.time) });
}

function removerMarcador(projeto: Project, args: Args): Resultado {
  const marcadorId = args.marcadorId as string;
  const ids = (projeto.markers ?? []).map((marker) => marker.id);
  if (!ids.includes(marcadorId)) {
    return falha("ARGUMENTO_INVALIDO", invalido("marcadorId", marcadorId, "id de um marcador que aparece em inspecionar"), { ids });
  }
  return concluir(projeto, removeMarker(projeto, marcadorId));
}

function definirMascara(projeto: Project, args: Args): Resultado {
  const clipeId = args.clipeId as string;
  const achado = editavel(projeto, clipeId);
  if (isFalha(achado)) return achado;
  if (!isVisual(achado, projeto)) return naoSuportada("máscara");
  const mascara = args.mascara as Mask | null;
  return concluir(
    projeto,
    updateSegment(projeto, clipeId, (segment) => {
      if (mascara) segment.mask = mascara;
      else delete segment.mask;
    }),
  );
}

function definirChroma(projeto: Project, args: Args): Resultado {
  const clipeId = args.clipeId as string;
  const achado = editavel(projeto, clipeId);
  if (isFalha(achado)) return achado;
  if (achado.track.type !== "video") return naoSuportada("chroma key");
  const chroma = args.chroma as Chroma | null;
  return concluir(
    projeto,
    updateSegment(projeto, clipeId, (segment) => {
      if (chroma) segment.chroma = chroma;
      else delete segment.chroma;
    }),
  );
}

function definirEfeito(projeto: Project, args: Args): Resultado {
  const clipeId = args.clipeId as string;
  const achado = editavel(projeto, clipeId);
  if (isFalha(achado)) return achado;
  if (!temVisual(achado, projeto)) return naoSuportada("efeitos");
  const efeito = args.efeito as EffectType;
  const valor = args.valor as number | null;
  if (valor !== null && achado.segment.keyframes[efeito]?.length) {
    return falha("ARGUMENTO_INVALIDO", invalido("valor", valor, `null, porque o efeito ${efeito} é animado; para mudar a intensidade, use definirPropriedade com tempo`));
  }
  return concluir(
    projeto,
    updateSegment(projeto, clipeId, (segment) => {
      const efeitos = { ...segment.effects };
      if (valor === null) {
        delete efeitos[efeito];
        delete segment.keyframes[efeito];
      } else {
        efeitos[efeito] = valor;
      }
      if (Object.keys(efeitos).length) segment.effects = efeitos;
      else delete segment.effects;
    }),
  );
}

function definirHsl(projeto: Project, args: Args): Resultado {
  const clipeId = args.clipeId as string;
  const achado = editavel(projeto, clipeId);
  if (isFalha(achado)) return achado;
  if (!temVisual(achado, projeto)) return naoSuportada("HSL");
  const cor = args.cor as HslColor;
  const ajuste = args.ajuste as HslShift | null;
  return concluir(
    projeto,
    updateSegment(projeto, clipeId, (segment) => {
      const hsl = { ...segment.hsl };
      if (ajuste) hsl[cor] = ajuste;
      else delete hsl[cor];
      if (Object.keys(hsl).length) segment.hsl = hsl;
      else delete segment.hsl;
    }),
  );
}

function definirCurvas(projeto: Project, args: Args): Resultado {
  const clipeId = args.clipeId as string;
  const achado = editavel(projeto, clipeId);
  if (isFalha(achado)) return achado;
  if (!temVisual(achado, projeto)) return naoSuportada("curvas");
  const canal = args.canal as CurveChannel;
  const pontos = args.pontos as CurvePoint[] | null;
  return concluir(
    projeto,
    updateSegment(projeto, clipeId, (segment) => {
      const curvas = { ...segment.curves };
      if (pontos) curvas[canal] = pontos;
      else delete curvas[canal];
      if (Object.keys(curvas).length) segment.curves = curvas;
      else delete segment.curves;
    }),
  );
}

function definirLut(projeto: Project, args: Args): Resultado {
  const clipeId = args.clipeId as string;
  const achado = editavel(projeto, clipeId);
  if (isFalha(achado)) return achado;
  if (!temVisual(achado, projeto)) return naoSuportada("LUT");
  const lutId = args.lutId as string | null;
  if (lutId !== null && !projeto.luts?.[lutId]) return falha("MATERIAL_NAO_ENCONTRADO", `LUT não encontrada: ${lutId}`);
  const strength = (args.forca as number | undefined) ?? achado.segment.lut?.strength ?? 1;
  return concluir(
    projeto,
    updateSegment(projeto, clipeId, (segment) => {
      if (lutId) segment.lut = { id: lutId, strength };
      else delete segment.lut;
    }),
  );
}

/** Later clips go first, so the times of the earlier ones stay valid. */
function cortarPorClipe(projeto: Project, palavras: PlacedWord[]): Project {
  const porClipe = new Map<string, { start: Us; end: Us }[]>();
  for (const { segmentId, start, end } of palavras) {
    porClipe.set(segmentId, [...(porClipe.get(segmentId) ?? []), { start, end }]);
  }
  return [...porClipe].reverse().reduce((atual, [id, trechos]) => cutSourceRanges(atual, id, trechos), projeto);
}

/**
 * What to cut of the measured silences still in this clip. Silence at an edge
 * of the clip goes whole, since there is no word to protect on that side.
 */
export function trechosDePausa(segment: Segment, minimo: Us): { start: Us; end: Us }[] {
  const inicio = segment.source.start;
  const fim = inicio + segment.source.duration;
  const margem = paraUs(PAUSE_MARGIN_SECONDS);
  const trechos: { start: Us; end: Us }[] = [];
  for (const pausa of segment.analise?.pausas ?? []) {
    const de = Math.max(pausa.inicio, inicio);
    const ate = Math.min(pausa.fim, fim);
    if (ate - de < minimo) continue;
    const start = de === inicio ? de : de + margem;
    const end = ate === fim ? ate : ate - margem;
    if (end > start) trechos.push({ start, end });
  }
  return trechos;
}

function cortarPausas(projeto: Project, args: Args): Resultado {
  const clipeId = args.clipeId as string;
  const achado = editavel(projeto, clipeId);
  if (isFalha(achado)) return achado;
  const { segment } = achado;
  if (!temFonte(achado, projeto) || segment.frozen || segment.reversed) return naoSuportada("corte de pausas");
  if (!segment.analise?.pausas) {
    return falha("ARGUMENTO_INVALIDO", invalido("clipeId", clipeId, "um clipe com análise de pausas; rode analisarPausas antes"));
  }
  const minimo = paraUs((args.minimo as number | undefined) ?? PAUSA_MINIMA_SEGUNDOS);
  const trechos = trechosDePausa(segment, minimo);
  if (trechos.length === 0) return concluir(projeto, projeto);
  return concluir(projeto, cutSourceRanges(projeto, clipeId, trechos));
}

/** A clip that can hold analysis: one with a source, on a track that accepts edits. */
function analisavel(projeto: Project, clipeId: string): Achado | Falha {
  const achado = editavel(projeto, clipeId);
  if (isFalha(achado)) return achado;
  return temFonte(achado, projeto) && !achado.segment.frozen ? achado : naoSuportada("análise");
}

/** The first of these source times outside the clip's source, as an error. */
function conferirFonte({ segment }: Achado, tempos: Us[]): Falha | null {
  const inicio = segment.source.start;
  const fim = inicio + segment.source.duration;
  const fora = tempos.find((tempo) => tempo < inicio || tempo > fim);
  if (fora === undefined) return null;
  const limites = { inicio: paraSegundos(inicio), fim: paraSegundos(fim) };
  return falha("FORA_DA_FONTE", `O tempo ${paraSegundos(fora)} está fora da fonte do clipe, de ${limites.inicio} a ${limites.fim}.`, limites);
}

/** Writes one field of the analysis; the same value again changes nothing, not even the date. */
function gravarAnalise<K extends keyof Analise>(
  projeto: Project,
  { segment }: Achado,
  campo: K,
  valor: Analise[K],
  patch?: (item: Segment) => void,
): Project {
  return updateSegment(projeto, segment.id, (item) => {
    patch?.(item);
    if (JSON.stringify(item.analise?.[campo]) === JSON.stringify(valor)) return;
    item.analise = { ...item.analise, versao: 1, geradoEm: new Date().toISOString(), [campo]: valor };
  });
}

function analisarCenas(projeto: Project, args: Args): Resultado {
  const achado = analisavel(projeto, args.clipeId as string);
  if (isFalha(achado)) return achado;
  const cenas = (args.cenas as number[]).map(paraUs);
  return conferirFonte(achado, cenas) ?? concluir(projeto, gravarAnalise(projeto, achado, "cenas", cenas));
}

function analisarPausas(projeto: Project, args: Args): Resultado {
  const achado = analisavel(projeto, args.clipeId as string);
  if (isFalha(achado)) return achado;
  const pausas = (args.pausas as { inicio: number; fim: number }[])
    .map(({ inicio, fim }) => ({ inicio: paraUs(inicio), fim: paraUs(fim) }))
    .sort((a, b) => a.inicio - b.inicio);
  const erro = conferirFonte(achado, pausas.flatMap(({ inicio, fim }) => [inicio, fim]));
  return erro ?? concluir(projeto, gravarAnalise(projeto, achado, "pausas", pausas));
}

function analisarBatidas(projeto: Project, args: Args): Resultado {
  const achado = analisavel(projeto, args.clipeId as string);
  if (isFalha(achado)) return achado;
  const batidas = (args.batidas as number[]).map(paraUs);
  const erro = conferirFonte(achado, batidas);
  return erro ?? concluir(projeto, gravarAnalise(projeto, achado, "batidas", batidas, (item) => void (item.beats = batidas)));
}

function analisarLoudness(projeto: Project, args: Args): Resultado {
  const achado = analisavel(projeto, args.clipeId as string);
  if (isFalha(achado)) return achado;
  return concluir(projeto, gravarAnalise(projeto, achado, "loudness", args.loudness as NonNullable<Analise["loudness"]>));
}

function transcrever(projeto: Project, args: Args): Resultado {
  const achado = analisavel(projeto, args.clipeId as string);
  if (isFalha(achado)) return achado;
  const words: Word[] = (args.palavras as Word[]).map(({ text, start, end }) => ({ text, start: paraUs(start), end: paraUs(end) }));
  const erro = conferirFonte(achado, words.flatMap(({ start, end }) => [start, end]));
  if (erro) return erro;
  return concluir(projeto, updateSegment(projeto, achado.segment.id, (segment) => void (segment.words = words)));
}

function cortarHesitacoes(projeto: Project, args: Args): Resultado {
  const achado = editavel(projeto, args.clipeId as string);
  if (isFalha(achado)) return achado;
  const palavras = trackWords(projeto, achado.track.id);
  if (palavras.length === 0) return concluir(projeto, projeto, ["A faixa não tem palavras transcritas."]);
  return concluir(projeto, cortarPorClipe(projeto, palavras.filter(isHesitation)));
}

function criarLegendas(projeto: Project, args: Args): Resultado {
  const achado = localizar(projeto, args.clipeId as string);
  if (isFalha(achado)) return achado;
  const cues = wordsToCues(trackWords(projeto, achado.track.id));
  if (cues.length === 0) return concluir(projeto, projeto, ["A faixa não tem palavras transcritas."]);
  return concluir(projeto, addSubtitles(projeto, cues));
}

// ---------- Comandos de criação: projeto, faixas, formas, estilo e movimento ----------

/** Project settings live outside clips and tracks, so the change is detected here, not by concluir. */
function definirProjeto(projeto: Project, args: Args): Resultado {
  const { nome, largura, altura, fps, fundo } = args as {
    nome?: string;
    largura?: number;
    altura?: number;
    fps?: number;
    fundo?: string | null;
  };
  const depois: Project = { ...projeto };
  if (nome !== undefined) depois.name = nome;
  if (largura !== undefined || altura !== undefined) {
    depois.canvas = { width: largura ?? projeto.canvas.width, height: altura ?? projeto.canvas.height };
  }
  if (fps !== undefined) depois.fps = fps;
  if (fundo === null) delete depois.background;
  else if (fundo !== undefined) depois.background = { kind: "color", color: fundo };
  const campos = (p: Project) => JSON.stringify([p.name, p.canvas, p.fps, p.background ?? null]);
  const alterado = campos(depois) !== campos(projeto);
  // The project itself is what changed, so its id stands for it.
  return { ok: true, projeto: alterado ? depois : projeto, alterado, afetados: alterado ? [projeto.id] : [], avisos: [] };
}

function criarFaixa(projeto: Project, args: Args): Resultado {
  const tipo = args.tipo as TrackType;
  const { project, trackId } = addTrack(projeto, tipo);
  let depois = args.nome === undefined ? project : updateTrack(project, trackId, { name: args.nome as string });
  const avisos: string[] = [];
  if (args.posicao !== undefined) {
    const tracks = [...depois.tracks];
    const [nova] = tracks.splice(tracks.length - 1, 1);
    const posicao = Math.min(args.posicao as number, tracks.length);
    if (posicao !== args.posicao) avisos.push(`posicao: pedida ${args.posicao as number}, efetiva ${posicao}.`);
    tracks.splice(posicao, 0, nova!);
    depois = { ...depois, tracks };
  }
  return concluir(projeto, depois, avisos);
}

/** Places a new text or shape at an exact time and length, as adicionarTexto does. */
function colocarComDuracao(
  projeto: Project,
  comMaterial: { project: Project; materialId: string },
  inicio: number,
  duracao: number,
  faixaId: string | undefined,
): Resultado {
  const wanted = paraUs(inicio);
  const duration = paraUs(duracao);
  const { project: colocado, segmentId } = placeMaterial(comMaterial.project, comMaterial.materialId, wanted, faixaId);
  const medido = updateSegment(colocado, segmentId, (segment) => {
    segment.target.duration = duration;
    segment.source.duration = duration;
  });
  const { track } = findSegment(medido, segmentId)!;
  const depois = moveSegment(medido, segmentId, wanted, track.id);
  const efetivo = findSegment(depois, segmentId)!.segment.target.start;
  return concluir(projeto, depois, efetivo === wanted ? [] : [aviso("Início ajustado ao espaço livre", wanted, efetivo)]);
}

function adicionarForma(projeto: Project, args: Args): Resultado {
  const faixaId = args.faixaId as string | undefined;
  const erro = conferirFaixa(projeto, faixaId, "text");
  if (erro) return erro;
  return colocarComDuracao(
    projeto,
    addShapeMaterial(projeto, args.forma as ShapeKind),
    args.inicio as number,
    args.duracao as number,
    faixaId,
  );
}

/** The material a clipeId or materialId points at, refusing locked tracks like definirTexto does. */
function materialAlvo(projeto: Project, args: Args): Material | Falha {
  const { clipeId, materialId } = args as { clipeId?: string; materialId?: string };
  if ((clipeId === undefined) === (materialId === undefined)) {
    return falha("ARGUMENTO_INVALIDO", invalido("materialId", materialId, "materialId ou clipeId, só um dos dois"));
  }
  let id = materialId;
  if (clipeId !== undefined) {
    const achado = localizar(projeto, clipeId);
    if (isFalha(achado)) return achado;
    id = achado.segment.materialId;
  }
  const material = projeto.materials[id!];
  if (!material) return falha("MATERIAL_NAO_ENCONTRADO", `Material não encontrado: ${id!}`);
  const bloqueada = faixasDoMaterial(projeto, material.id).find((track) => track.locked);
  if (bloqueada) return falha("FAIXA_BLOQUEADA", `A faixa "${bloqueada.name}" está bloqueada.`);
  return material;
}

function estilizar(projeto: Project, args: Args): Resultado {
  const material = materialAlvo(projeto, args);
  if (isFalha(material)) return material;
  if (material.kind !== "text" && material.kind !== "shape") return naoSuportada("estilo; só textos e formas têm");
  const problema = conferirEstilo(material.kind, args.estilo, "estilo");
  if (problema) return falha("ARGUMENTO_INVALIDO", problema);
  const estilo = { ...(args.estilo as Record<string, unknown>) };
  // null removes an optional part, such as the shadow or the spoken word style.
  const remover = Object.keys(estilo).filter((chave) => estilo[chave] === null);
  for (const chave of remover) delete estilo[chave];
  const depois = updateMaterial(projeto, material.id, estilo as Partial<Material>);
  if (remover.length === 0) return concluir(projeto, depois);
  const limpo = { ...depois.materials[material.id]! } as unknown as Record<string, unknown>;
  for (const chave of remover) delete limpo[chave];
  return concluir(projeto, { ...depois, materials: { ...depois.materials, [material.id]: limpo as unknown as Material } });
}

function definirAnimacao(projeto: Project, args: Args): Resultado {
  const clipeId = args.clipeId as string;
  const achado = editavel(projeto, clipeId);
  if (isFalha(achado)) return achado;
  if (!isVisual(achado, projeto)) return naoSuportada("animação");
  const lerAnimacao = (valor: unknown) => {
    const { tipo, duracao } = valor as { tipo: string; duracao: number };
    return { type: tipo, duration: paraUs(duracao) };
  };
  const depois = updateSegment(projeto, clipeId, (segment) => {
    for (const [arg, campo] of [["entrada", "animIn"], ["saida", "animOut"], ["loop", "animLoop"]] as const) {
      if (args[arg] === undefined) continue;
      if (args[arg] === null) delete segment[campo];
      else (segment as unknown as Record<string, unknown>)[campo] = lerAnimacao(args[arg]);
    }
  });
  return concluir(projeto, depois);
}

function definirMoldura(projeto: Project, args: Args): Resultado {
  const clipeId = args.clipeId as string;
  const achado = editavel(projeto, clipeId);
  if (isFalha(achado)) return achado;
  const kind = materialDe(projeto, achado.segment)?.kind;
  if (kind !== "video" && kind !== "image") return naoSuportada("moldura");
  const moldura = args.moldura as ClipFrame | null;
  return concluir(
    projeto,
    updateSegment(projeto, clipeId, (segment) => {
      if (moldura === null) delete segment.frame;
      else segment.frame = { ...moldura };
    }),
  );
}

function definirEnquadramento(projeto: Project, args: Args): Resultado {
  const clipeId = args.clipeId as string;
  const achado = editavel(projeto, clipeId);
  if (isFalha(achado)) return achado;
  const kind = materialDe(projeto, achado.segment)?.kind;
  if (kind !== "video" && kind !== "image") return naoSuportada("enquadramento");
  const enquadramento = args.enquadramento as Fit;
  return concluir(
    projeto,
    updateSegment(projeto, clipeId, (segment) => {
      if (enquadramento === "cover") segment.fit = "cover";
      else delete segment.fit;
    }),
  );
}

function definirFades(projeto: Project, args: Args): Resultado {
  const clipeId = args.clipeId as string;
  const achado = editavel(projeto, clipeId);
  if (isFalha(achado)) return achado;
  if (!temFonte(achado, projeto)) return naoSuportada("fade de áudio");
  const { duration } = achado.segment.target;
  const avisos: string[] = [];
  const limitar = (nome: string, valor: unknown): Us | undefined => {
    if (valor === undefined) return undefined;
    const pedido = paraUs(valor as number);
    if (pedido > duration) avisos.push(aviso(`${nome} limitado à duração do clipe`, pedido, duration));
    return Math.min(pedido, duration);
  };
  const entrada = limitar("Fade de entrada", args.entrada);
  const saida = limitar("Fade de saída", args.saida);
  const depois = updateSegment(projeto, clipeId, (segment) => {
    if (entrada !== undefined) segment.fadeIn = entrada;
    if (saida !== undefined) segment.fadeOut = saida;
  });
  return concluir(projeto, depois, avisos);
}

function definirEfeitosDeAudio(projeto: Project, args: Args): Resultado {
  const clipeId = args.clipeId as string;
  const achado = editavel(projeto, clipeId);
  if (isFalha(achado)) return achado;
  if (!temFonte(achado, projeto)) return naoSuportada("efeitos de áudio");
  const efeitos = args.efeitos as AudioEffects | null;
  return concluir(
    projeto,
    updateSegment(projeto, clipeId, (segment) => {
      if (efeitos === null) delete segment.audioEffects;
      else segment.audioEffects = { ...efeitos };
    }),
  );
}

const TRANSFORMACAO: Record<string, AnimatableProp> = {
  x: "x",
  y: "y",
  escala: "scale",
  rotacao: "rotation",
  opacidade: "opacity",
};

/** Several placement values at once, for clips that do not animate them. */
function definirTransformacao(projeto: Project, args: Args): Resultado {
  const clipeId = args.clipeId as string;
  const achado = editavel(projeto, clipeId);
  if (isFalha(achado)) return achado;
  if (!isVisual(achado, projeto)) return naoSuportada("posição");
  const pedidos = Object.entries(TRANSFORMACAO).filter(([arg]) => args[arg] !== undefined);
  const animada = pedidos.find(([, prop]) => achado.segment.keyframes[prop]?.length);
  if (animada) {
    return falha("ARGUMENTO_INVALIDO", invalido(animada[0], args[animada[0]], `nada, porque ${animada[1]} é animada; use definirKeyframe`));
  }
  const depois = updateSegment(projeto, clipeId, (segment) => {
    for (const [arg, prop] of pedidos) segment.transform[prop] = args[arg] as number;
  });
  return concluir(projeto, depois);
}

const LEGENDA_PADRAO = {
  fontFamily: "Arial",
  fontSize: 96,
  color: "#ffffff",
  bold: true,
  italic: false,
  align: "center" as const,
  strokeColor: "#000000",
  strokeWidth: 8,
  background: "",
};
const LEGENDA_MAX_PALAVRAS = 3;
const LEGENDA_MAX_LETRAS = 18;
const LEGENDA_SOBRA_SEGUNDOS = 0.3;
const LEGENDA_PAUSA_QUEBRA: Us = 700_000;
const LEGENDA_Y = -0.4;
const FIM_DE_FRASE = /[.,!?…;:]$/;

interface PalavraDita {
  texto: string;
  inicio: number;
  fim: number;
  /** Ends the caption after this word, as punctuation would, for sentence ends written without it. */
  quebra?: boolean;
}

/** Splits spoken words into short captions: few words, few letters, and a break at punctuation and pauses. */
export function agruparLegendas(palavras: PalavraDita[], maxPalavras: number, maxLetras: number): PalavraDita[][] {
  const grupos: PalavraDita[][] = [];
  let atual: PalavraDita[] = [];
  for (const palavra of palavras) {
    const ultima = atual[atual.length - 1];
    const letras = atual.reduce((total, item) => total + item.texto.length + 1, palavra.texto.length);
    const pausa = ultima ? paraUs(palavra.inicio) - paraUs(ultima.fim) : 0;
    if (ultima && (atual.length >= maxPalavras || letras > maxLetras || pausa > LEGENDA_PAUSA_QUEBRA)) {
      grupos.push(atual);
      atual = [];
    }
    atual.push(palavra);
    if (palavra.quebra || FIM_DE_FRASE.test(palavra.texto)) {
      grupos.push(atual);
      atual = [];
    }
  }
  if (atual.length) grupos.push(atual);
  return grupos;
}

/** Word-by-word captions from timed words: one text clip per group, the word being said highlighted. */
function adicionarLegendas(projeto: Project, args: Args): Resultado {
  const faixaId = args.faixaId as string | undefined;
  const erro = conferirFaixa(projeto, faixaId, "text");
  if (erro) return erro;
  const maiusculas = Boolean(args.maiusculas);
  const palavras = [...(args.palavras as PalavraDita[])]
    .sort((a, b) => a.inicio - b.inicio)
    .map((palavra) => ({ ...palavra, texto: maiusculas ? palavra.texto.toLocaleUpperCase("pt-BR") : palavra.texto }));
  const grupos = agruparLegendas(
    palavras,
    (args.maxPalavras as number | undefined) ?? LEGENDA_MAX_PALAVRAS,
    (args.maxLetras as number | undefined) ?? LEGENDA_MAX_LETRAS,
  );
  const sobra = paraUs((args.sobra as number | undefined) ?? LEGENDA_SOBRA_SEGUNDOS);
  const estilo = (args.estilo as Record<string, unknown> | undefined) ?? {};
  const destaque = args.destaque as { cor: string; escala?: number; caixa?: string; modo?: "highlight" | "single" } | undefined;
  const entrada = args.entrada as { tipo: EntranceType; duracao: number } | undefined;
  const y = (args.y as number | undefined) ?? LEGENDA_Y;

  let depois = projeto;
  let trackId = faixaId;
  if (!trackId) {
    const criada = addTrack(depois, "text");
    trackId = criada.trackId;
    depois = updateTrack(criada.project, trackId, { name: (args.nome as string | undefined) ?? "Legendas" });
  }
  const materials = { ...depois.materials };
  const track = { ...depois.tracks.find((item) => item.id === trackId)!, segments: [...depois.tracks.find((item) => item.id === trackId)!.segments] };
  const avisos: string[] = [];
  grupos.forEach((grupo, index) => {
    const inicio = paraUs(grupo[0]!.inicio);
    const seguinte = grupos[index + 1]?.[0];
    const fim = Math.min(paraUs(grupo[grupo.length - 1]!.fim) + sobra, seguinte ? paraUs(seguinte.inicio) : Number.MAX_SAFE_INTEGER);
    const duration = Math.max(frameDuration(projeto), fim - inicio);
    const material: TextMaterial = {
      id: newId(),
      kind: "text",
      ...LEGENDA_PADRAO,
      ...(estilo as Partial<TextMaterial>),
      text: grupo.map((palavra) => palavra.texto).join(" "),
      timing: grupo.map((palavra) => ({
        text: palavra.texto,
        start: paraUs(palavra.inicio) - inicio,
        end: paraUs(palavra.fim) - inicio,
      })),
      ...(destaque
        ? {
            spoken: {
              mode: destaque.modo ?? "highlight",
              color: destaque.cor,
              ...(destaque.escala !== undefined ? { scale: destaque.escala } : {}),
              ...(destaque.caixa ? { box: destaque.caixa } : {}),
            },
          }
        : {}),
    };
    materials[material.id] = material;
    const segment = makeSegment(material, inicio);
    segment.target.duration = duration;
    segment.source.duration = duration;
    segment.transform.y = y;
    if (entrada) segment.animIn = { type: entrada.tipo, duration: paraUs(entrada.duracao) };
    const livre = nearestFreeStart(track, inicio, duration);
    if (livre !== inicio) avisos.push(aviso(`Legenda "${material.text}" movida para um espaço livre`, inicio, livre));
    segment.target.start = livre;
    track.segments.push(segment);
    track.segments.sort((a, b) => a.target.start - b.target.start);
  });
  depois = { ...depois, materials, tracks: depois.tracks.map((item) => (item.id === trackId ? track : item)) };
  return concluir(projeto, depois, avisos);
}

const COMANDOS: Record<string, (projeto: Project, args: Args) => Resultado> = {
  definirProjeto,
  criarFaixa,
  adicionarForma,
  estilizar,
  definirAnimacao,
  definirMoldura,
  definirEnquadramento,
  definirFades,
  definirEfeitosDeAudio,
  definirTransformacao,
  adicionarLegendas,
  adicionarClipe,
  moverClipe,
  aparar,
  dividir,
  excluir,
  duplicar,
  definirVelocidade,
  congelarQuadro,
  definirPropriedade,
  definirKeyframe,
  removerKeyframe,
  definirSuavizacao,
  definirRecorte,
  adicionarTexto,
  definirTexto,
  substituirTexto,
  definirVolume,
  cortarTrechos,
  marcar,
  removerMarcador,
  definirMascara,
  definirChroma,
  definirEfeito,
  definirHsl,
  definirCurvas,
  definirLut,
  analisarCenas,
  analisarPausas,
  analisarBatidas,
  analisarLoudness,
  transcrever,
  cortarPausas,
  cortarHesitacoes,
  criarLegendas,
};

/** Runs one command. The project passed in never changes. */
export function executarComando(projeto: Project, comando: string, args: unknown = {}): Resultado {
  const executar = Object.hasOwn(COMANDOS, comando) ? COMANDOS[comando] : undefined;
  if (!executar || !Object.hasOwn(ESQUEMA, comando)) {
    return falha("COMANDO_DESCONHECIDO", `Comando desconhecido: ${comando}`);
  }
  const problema = conferirArgumentos(comando, args);
  if (problema) return falha("ARGUMENTO_INVALIDO", problema);
  return executar(projeto, args as Args);
}

// ---------- Planos: vários comandos aplicados de uma vez ----------

export interface Passo {
  comando: string;
  args?: Record<string, unknown>;
  /** Names what the step created, so later steps can point at it as "$nome". */
  como?: string;
}

export interface RelatorioPasso {
  indice: number;
  comando: string;
  ok: boolean;
  codigo?: CodigoErro;
  mensagem?: string;
  /** The id given to "como", when the step named one. */
  id?: string;
  afetados: string[];
  avisos: string[];
}

export interface ResultadoPlano {
  ok: boolean;
  /** With falharAoPrimeiroErro and an error, this is the project as it came in. */
  projeto: Project;
  alterado: boolean;
  relatorio: RelatorioPasso[];
  /** Every "como" name and the id it got. */
  nomes: Record<string, string>;
}

const REFERENCIA = /^\$([A-Za-z_][\w-]*)$/;
const POR_NOME = /^@(.+)$/;
const NOME_DE_PASSO = /^[A-Za-z_][\w-]*$/;

/** What a plan is wrong with before anything runs: shape, commands, arguments and names. */
export function conferirPlano(passos: unknown): { indice: number; mensagem: string } | null {
  if (!Array.isArray(passos)) return { indice: -1, mensagem: invalido("passos", passos, "lista de passos") };
  const nomes = new Set<string>();
  for (let indice = 0; indice < passos.length; indice += 1) {
    const passo = passos[indice] as Passo;
    if (typeof passo !== "object" || passo === null || Array.isArray(passo)) {
      return { indice, mensagem: invalido(`passos[${indice}]`, passo, "objeto { comando, args, como }") };
    }
    if (!Object.hasOwn(ESQUEMA, passo.comando) || !Object.hasOwn(COMANDOS, passo.comando)) {
      return { indice, mensagem: `Comando desconhecido: ${String(passo.comando)}` };
    }
    const problema = conferirArgumentos(passo.comando, passo.args ?? {});
    if (problema) return { indice, mensagem: problema };
    if (passo.como !== undefined) {
      if (typeof passo.como !== "string" || !NOME_DE_PASSO.test(passo.como)) {
        return { indice, mensagem: invalido("como", passo.como, "nome com letras, números, _ ou -, começando por letra") };
      }
      if (nomes.has(passo.como)) return { indice, mensagem: invalido("como", passo.como, "nome ainda não usado no plano") };
      nomes.add(passo.como);
    }
    for (const [nome, valor] of Object.entries(passo.args ?? {})) {
      const ref = typeof valor === "string" ? REFERENCIA.exec(valor) : null;
      if (ref && ESQUEMA[passo.comando]!.argumentos[nome]?.tipo === "id" && !nomes.has(ref[1]!)) {
        return { indice, mensagem: invalido(nome, valor, "referência a um \"como\" de um passo anterior") };
      }
    }
  }
  return null;
}

/** Turns "$nome" and "@arquivo" in id arguments into real ids. Other arguments are taken as written. */
function resolverArgs(projeto: Project, comando: string, args: Record<string, unknown>, nomes: Record<string, string>): Record<string, unknown> | Falha {
  const resolvidos: Record<string, unknown> = { ...args };
  for (const [nome, valor] of Object.entries(args)) {
    if (typeof valor !== "string" || ESQUEMA[comando]!.argumentos[nome]?.tipo !== "id") continue;
    const ref = REFERENCIA.exec(valor);
    if (ref) {
      resolvidos[nome] = nomes[ref[1]!];
      continue;
    }
    const porNome = POR_NOME.exec(valor);
    if (porNome) {
      const material = Object.values(projeto.materials).find((item) => "name" in item && item.name === porNome[1]);
      if (!material) return falha("MATERIAL_NAO_ENCONTRADO", `Nenhum material importado se chama "${porNome[1]!}".`);
      resolvidos[nome] = material.id;
    }
  }
  return resolvidos;
}

/** The id a step is known by: the track it made, or else the clip, or else whatever came first. */
function idPrincipal(comando: string, depois: Project, afetados: string[], antes: Project): string | undefined {
  const criados = afetados.filter((id) => !indice(antes).has(id));
  const faixas = new Set(depois.tracks.map((track) => track.id));
  if (comando === "criarFaixa" || comando === "adicionarLegendas") return criados.find((id) => faixas.has(id)) ?? afetados[0];
  return criados.find((id) => findSegment(depois, id)) ?? afetados[0];
}

/**
 * Runs a whole plan on a draft. The plan is checked first, and a check that
 * fails runs nothing. With falharAoPrimeiroErro, the first failing step stops
 * the plan and nothing is applied; without it, failing steps are skipped.
 */
export function executarPlano(projeto: Project, passos: Passo[], { falharAoPrimeiroErro = true } = {}): ResultadoPlano {
  const problema = conferirPlano(passos);
  if (problema) {
    const passo = passos[problema.indice] as Passo | undefined;
    return {
      ok: false,
      projeto,
      alterado: false,
      nomes: {},
      relatorio: [{ indice: problema.indice, comando: String(passo?.comando ?? ""), ok: false, codigo: "ARGUMENTO_INVALIDO", mensagem: problema.mensagem, afetados: [], avisos: [] }],
    };
  }
  let atual = projeto;
  const nomes: Record<string, string> = {};
  const relatorio: RelatorioPasso[] = [];
  let falhou = false;
  for (let i = 0; i < passos.length; i += 1) {
    const { comando, args = {}, como } = passos[i]!;
    const resolvidos = resolverArgs(atual, comando, args, nomes);
    const resultado = isFalha(resolvidos as object) ? (resolvidos as Falha) : executarComando(atual, comando, resolvidos);
    if (!resultado.ok) {
      falhou = true;
      relatorio.push({ indice: i, comando, ok: false, codigo: resultado.codigo, mensagem: resultado.mensagem, afetados: [], avisos: [] });
      if (falharAoPrimeiroErro) return { ok: false, projeto, alterado: false, relatorio, nomes };
      continue;
    }
    const id = como ? idPrincipal(comando, resultado.projeto, resultado.afetados, atual) : undefined;
    if (como && id) nomes[como] = id;
    relatorio.push({ indice: i, comando, ok: true, ...(id ? { id } : {}), afetados: resultado.afetados, avisos: resultado.avisos });
    atual = resultado.projeto;
  }
  return { ok: !falhou, projeto: atual, alterado: atual !== projeto, relatorio, nomes };
}

function analiseEmSegundos({ geradoEm, cenas, pausas, batidas, loudness }: Analise) {
  return {
    geradoEm,
    ...(cenas ? { cenas: cenas.map(paraSegundos) } : {}),
    ...(pausas ? { pausas: pausas.map(({ inicio, fim }) => ({ inicio: paraSegundos(inicio), fim: paraSegundos(fim) })) } : {}),
    ...(batidas ? { batidas: batidas.map(paraSegundos) } : {}),
    ...(loudness ? { loudness } : {}),
  };
}

/** The project as data for an agent: structure and timing, never the media itself. */
export function inspecionar(projeto: Project) {
  const clipe = (segment: Segment) => ({
    id: segment.id,
    tipo: materialDe(projeto, segment)?.kind ?? null,
    inicio: paraSegundos(segment.target.start),
    duracao: paraSegundos(segment.target.duration),
    fonte: { inicio: paraSegundos(segment.source.start), duracao: paraSegundos(segment.source.duration) },
    materialId: segment.materialId,
    velocidade: segment.speed,
    volume: segment.volume,
    palavras: segment.words?.length ?? 0,
    batidas: segment.beats?.length ?? 0,
    ...(segment.analise ? { analise: analiseEmSegundos(segment.analise) } : {}),
    animadas: Object.fromEntries(
      Object.entries(segment.keyframes).map(([propriedade, keyframes]) => [
        propriedade,
        (keyframes ?? []).map(({ offset }) => paraSegundos(segment.target.start + offset)),
      ]),
    ),
  });
  return {
    nome: projeto.name,
    fps: projeto.fps,
    canvas: { largura: projeto.canvas.width, altura: projeto.canvas.height },
    duracao: paraSegundos(projectDuration(projeto)),
    faixas: projeto.tracks.map((track) => ({
      id: track.id,
      tipo: track.type,
      nome: track.name,
      bloqueada: Boolean(track.locked),
      oculta: track.hidden,
      muda: track.muted,
      clipes: track.segments.map(clipe),
    })),
    marcadores: (projeto.markers ?? []).map(({ id, time, label }) => ({ id, tempo: paraSegundos(time), rotulo: label })),
    materiais: Object.values(projeto.materials).map((material) => ({
      id: material.id,
      tipo: material.kind,
      ...("name" in material
        ? {
            nome: material.name,
            duracao: paraSegundos(material.duration),
            largura: material.width,
            altura: material.height,
            temAudio: material.hasAudio,
            offline: Boolean(material.offline),
          }
        : {}),
      ...(material.kind === "text" ? { texto: material.text } : {}),
    })),
    luts: Object.values(projeto.luts ?? {}).map(({ id, name }) => ({ id, nome: name })),
  };
}

export interface Problema {
  codigo: "DURACAO_ZERO" | "SOBREPOSICAO_NA_FAIXA" | "MATERIAL_OFFLINE" | "TEXTO_VAZIO" | "FAIXA_BLOQUEADA_COM_CLIPES";
  gravidade: "erro" | "aviso";
  mensagem: string;
  clipeId?: string;
  faixaId?: string;
  tempo?: number;
}

/** What can be checked from the project data alone. Changes nothing. */
export function validar(projeto: Project): Problema[] {
  const problemas: Problema[] = [];
  for (const track of projeto.tracks) {
    if (track.locked && track.segments.length) {
      problemas.push({
        codigo: "FAIXA_BLOQUEADA_COM_CLIPES",
        gravidade: "aviso",
        mensagem: `A faixa "${track.name}" está bloqueada e recusa edições.`,
        faixaId: track.id,
      });
    }
    track.segments.forEach((segment, index) => {
      const base = { clipeId: segment.id, tempo: paraSegundos(segment.target.start) };
      const material = materialDe(projeto, segment);
      if (segment.target.duration <= 0) {
        problemas.push({ ...base, codigo: "DURACAO_ZERO", gravidade: "erro", mensagem: "O clipe tem duração zero." });
      }
      const seguinte = track.segments[index + 1];
      if (seguinte && seguinte.target.start < segmentEnd(segment)) {
        problemas.push({ ...base, codigo: "SOBREPOSICAO_NA_FAIXA", gravidade: "erro", mensagem: `O clipe invade o clipe ${seguinte.id}.` });
      }
      if (material && "offline" in material && material.offline) {
        problemas.push({ ...base, codigo: "MATERIAL_OFFLINE", gravidade: "erro", mensagem: `O arquivo "${material.name}" não está disponível.` });
      }
      if (material?.kind === "text" && !material.text.trim()) {
        problemas.push({ ...base, codigo: "TEXTO_VAZIO", gravidade: "aviso", mensagem: "O texto está vazio." });
      }
    });
  }
  return problemas;
}
