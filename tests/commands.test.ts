import { describe, expect, it } from "vitest";
import { ESQUEMA, conferirArgumentos } from "../src/core/commandSchema";
import { executarComando, inspecionar, validar, type CodigoErro, type Resultado } from "../src/core/commands";
import { createProject, findSegment, type MediaMaterial, type Project } from "../src/core/model";
import { packProject, unpackProject } from "../src/core/projectFile";
import { addTextMaterial, addTrack, placeMaterial, setGroup, updateSegment, updateTrack } from "../src/core/ops";

const S = 1_000_000;
const MASCARA = { shape: "circle", x: 0, y: 0, width: 0.5, height: 0.5, rotation: 0, feather: 0, invert: false };
const CHROMA = { color: "#00ff00", strength: 0.3, softness: 0.2, spill: 0.5 };
const HSL = { hue: 10, saturation: -20, lightness: 0 };
const LOUDNESS = { integrado: -14, pico: -1 };
const MOLDURA = { radius: 0.04, strokeColor: "#ffffff", strokeWidth: 0.01, shadowColor: "rgba(0,0,0,0.5)", shadowSize: 0.08 };
const EFEITOS_AUDIO = { low: -1, mid: 1, high: 2, compressor: true, reverb: 0 };
const PALAVRAS_DITAS = [
  { texto: "Quem", inicio: 0.1, fim: 0.4 },
  { texto: "toca", inicio: 0.4, fim: 0.7 },
  { texto: "piano", inicio: 0.7, fim: 1.1 },
  { texto: "de", inicio: 1.1, fim: 1.2 },
  { texto: "ouvido.", inicio: 1.2, fim: 1.6 },
];

function media(id: string, kind: MediaMaterial["kind"], seconds: number, hasAudio = true): MediaMaterial {
  return { id, kind, name: `${id}.bin`, duration: seconds * S, width: 1920, height: 1080, hasAudio };
}

interface Cena {
  projeto: Project;
  video: string;
  foto: string;
  musica: string;
  texto: string;
  textoMaterial: string;
  faixaVideo: string;
  faixaTexto: string;
}

/** A video from 0 to 10 with spoken words, a photo at 20, music at 0 and a text at 0. */
function cena(): Cena {
  let projeto = createProject();
  projeto = {
    ...projeto,
    materials: { filme: media("filme", "video", 10), retrato: media("retrato", "image", 0, false), som: media("som", "audio", 8) },
    luts: { lut1: { id: "lut1", name: "Quente" } },
  };
  const video = placeMaterial(projeto, "filme", 0);
  const foto = placeMaterial(video.project, "retrato", 20 * S);
  const musica = placeMaterial(foto.project, "som", 0);
  const added = addTextMaterial(musica.project, "Olá Retalo");
  const texto = placeMaterial(added.project, added.materialId, 0);
  projeto = updateSegment(texto.project, video.segmentId, (segment) => {
    segment.words = [
      { text: "bom", start: 0, end: 0.5 * S },
      { text: "hum", start: 0.6 * S, end: 0.9 * S },
      { text: "dia", start: 3 * S, end: 3.5 * S },
    ];
  });
  return {
    projeto,
    video: video.segmentId,
    foto: foto.segmentId,
    musica: musica.segmentId,
    texto: texto.segmentId,
    textoMaterial: added.materialId,
    faixaVideo: findSegment(projeto, video.segmentId)!.track.id,
    faixaTexto: findSegment(projeto, texto.segmentId)!.track.id,
  };
}

const sucesso = (resultado: Resultado) => {
  if (!resultado.ok) throw new Error(`${resultado.codigo}: ${resultado.mensagem}`);
  return resultado;
};
const clipe = (projeto: Project, id: string) => findSegment(projeto, id)!.segment;

/** With a brightness animated from 0 to 2 seconds. */
function animada(c: Cena): Project {
  const um = sucesso(executarComando(c.projeto, "definirKeyframe", { clipeId: c.video, propriedade: "brightness", tempo: 0 }));
  return sucesso(executarComando(um.projeto, "definirKeyframe", { clipeId: c.video, propriedade: "brightness", tempo: 2 })).projeto;
}

const comMarcador = (c: Cena): Project => ({ ...c.projeto, markers: [{ id: "m1", time: 3 * S, label: "Marcador 01", color: "#2fb8c6" }] });

/** The photo at 20 and a second photo at 26, together in a group. */
function agrupada(c: Cena): { projeto: Project; outra: string } {
  const outra = placeMaterial(c.projeto, "retrato", 26 * S);
  return { projeto: setGroup(outra.project, [c.foto, outra.segmentId], "g1"), outra: outra.segmentId };
}

/** Silences at 1 to 2 and at 4 to 4.3 seconds of the video's source. */
const comPausas = (c: Cena): Project =>
  sucesso(executarComando(c.projeto, "analisarPausas", { clipeId: c.video, pausas: [{ inicio: 1, fim: 2 }, { inicio: 4, fim: 4.3 }] })).projeto;

type Caso = { comando: string; args: (c: Cena) => Record<string, unknown>; preparo?: (c: Cena) => Project };

const SUCESSOS: Caso[] = [
  { comando: "adicionarClipe", args: () => ({ materialId: "retrato", inicio: 40 }) },
  { comando: "moverClipe", args: (c) => ({ clipeId: c.foto, inicio: 30, faixaId: c.faixaVideo }) },
  { comando: "aparar", args: (c) => ({ clipeId: c.video, lado: "fim", tempo: 6 }) },
  { comando: "dividir", args: (c) => ({ clipeId: c.video, tempo: 5 }) },
  { comando: "excluir", args: (c) => ({ clipeId: c.foto }) },
  { comando: "duplicar", args: (c) => ({ clipeId: c.foto }) },
  { comando: "definirVelocidade", args: (c) => ({ clipeId: c.video, velocidade: 2 }) },
  { comando: "congelarQuadro", args: (c) => ({ clipeId: c.video, tempo: 4, duracao: 1 }) },
  { comando: "definirPropriedade", args: (c) => ({ clipeId: c.video, propriedade: "opacity", valor: 0.5 }) },
  { comando: "definirKeyframe", args: (c) => ({ clipeId: c.video, propriedade: "x", tempo: 1 }) },
  { comando: "removerKeyframe", args: (c) => ({ clipeId: c.video, propriedade: "brightness", tempo: 2 }), preparo: animada },
  { comando: "definirSuavizacao", args: (c) => ({ clipeId: c.video, suavizacao: "in" }), preparo: animada },
  { comando: "definirRecorte", args: (c) => ({ clipeId: c.video, borda: "left", valor: 0.2 }) },
  { comando: "adicionarTexto", args: () => ({ texto: "Novo", inicio: 30, duracao: 2 }) },
  { comando: "definirTexto", args: (c) => ({ clipeId: c.texto, texto: "Outro" }) },
  { comando: "substituirTexto", args: () => ({ de: "Retalo", para: "Retalho" }) },
  { comando: "definirVolume", args: (c) => ({ clipeId: c.video, volume: 0.5 }) },
  { comando: "cortarTrechos", args: (c) => ({ clipeId: c.video, trechos: [{ inicio: 1, fim: 2 }] }) },
  { comando: "marcar", args: () => ({ tempo: 3 }) },
  { comando: "removerMarcador", args: () => ({ marcadorId: "m1" }), preparo: comMarcador },
  { comando: "definirMascara", args: (c) => ({ clipeId: c.video, mascara: MASCARA }) },
  { comando: "definirChroma", args: (c) => ({ clipeId: c.video, chroma: CHROMA }) },
  { comando: "definirEfeito", args: (c) => ({ clipeId: c.video, efeito: "blur", valor: 0.4 }) },
  { comando: "definirHsl", args: (c) => ({ clipeId: c.video, cor: "red", ajuste: HSL }) },
  { comando: "definirCurvas", args: (c) => ({ clipeId: c.video, canal: "master", pontos: [[0, 0], [0.5, 0.7], [1, 1]] }) },
  { comando: "definirLut", args: (c) => ({ clipeId: c.video, lutId: "lut1", forca: 0.5 }) },
  { comando: "analisarCenas", args: (c) => ({ clipeId: c.video, cenas: [1, 4.5] }) },
  { comando: "analisarPausas", args: (c) => ({ clipeId: c.video, pausas: [{ inicio: 1, fim: 2 }] }) },
  { comando: "analisarBatidas", args: (c) => ({ clipeId: c.video, batidas: [0.5, 1] }) },
  { comando: "analisarLoudness", args: (c) => ({ clipeId: c.video, loudness: LOUDNESS }) },
  { comando: "transcrever", args: (c) => ({ clipeId: c.video, palavras: [{ text: "oi", start: 1, end: 1.5 }] }) },
  { comando: "cortarPausas", args: (c) => ({ clipeId: c.video }), preparo: comPausas },
  { comando: "cortarHesitacoes", args: (c) => ({ clipeId: c.video }) },
  { comando: "criarLegendas", args: (c) => ({ clipeId: c.video }) },
  { comando: "definirProjeto", args: () => ({ largura: 1080, altura: 1920, fundo: "#101010" }) },
  { comando: "criarFaixa", args: () => ({ tipo: "video", nome: "Livro" }) },
  { comando: "adicionarForma", args: () => ({ forma: "rectangle", inicio: 30, duracao: 2 }) },
  { comando: "estilizar", args: (c) => ({ clipeId: c.texto, estilo: { color: "#ffd23f", background: "#000000", backgroundRadius: 1 } }) },
  { comando: "definirAnimacao", args: (c) => ({ clipeId: c.texto, entrada: { tipo: "pop", duracao: 0.3 }, loop: { tipo: "pulse", duracao: 1 } }) },
  { comando: "definirMoldura", args: (c) => ({ clipeId: c.foto, moldura: MOLDURA }) },
  { comando: "definirEnquadramento", args: (c) => ({ clipeId: c.foto, enquadramento: "cover" }) },
  { comando: "definirFades", args: (c) => ({ clipeId: c.musica, entrada: 0.5, saida: 1 }) },
  { comando: "definirEfeitosDeAudio", args: (c) => ({ clipeId: c.musica, efeitos: EFEITOS_AUDIO }) },
  { comando: "definirTransformacao", args: (c) => ({ clipeId: c.texto, x: 0.2, y: -0.4, escala: 1.2 }) },
  { comando: "adicionarLegendas", args: () => ({ palavras: PALAVRAS_DITAS, destaque: { cor: "#ffd23f", escala: 1.15 } }) },
];

/** Errors a single command can answer with, beyond those every clip command shares. */
const ERROS: (Caso & { codigo: CodigoErro })[] = [
  { comando: "adicionarClipe", codigo: "MATERIAL_NAO_ENCONTRADO", args: () => ({ materialId: "nada", inicio: 0 }) },
  { comando: "adicionarClipe", codigo: "ARGUMENTO_INVALIDO", args: () => ({ materialId: "retrato", inicio: 0, faixaId: "nada" }) },
  { comando: "adicionarClipe", codigo: "TIPO_DE_FAIXA_INCOMPATIVEL", args: (c) => ({ materialId: "som", inicio: 0, faixaId: c.faixaVideo }) },
  {
    comando: "adicionarClipe",
    codigo: "FAIXA_BLOQUEADA",
    args: (c) => ({ materialId: "retrato", inicio: 0, faixaId: c.faixaVideo }),
    preparo: (c) => updateTrack(c.projeto, c.faixaVideo, { locked: true }),
  },
  { comando: "moverClipe", codigo: "ARGUMENTO_INVALIDO", args: (c) => ({ clipeId: c.foto, inicio: 0, faixaId: "nada" }) },
  { comando: "moverClipe", codigo: "TIPO_DE_FAIXA_INCOMPATIVEL", args: (c) => ({ clipeId: c.foto, inicio: 0, faixaId: c.faixaTexto }) },
  {
    comando: "moverClipe",
    codigo: "FAIXA_BLOQUEADA",
    args: (c) => ({ clipeId: c.foto, inicio: 0, faixaId: "destino" }),
    preparo: (c) => ({
      ...c.projeto,
      tracks: [...c.projeto.tracks, { id: "destino", type: "video", name: "Fechada", muted: false, hidden: false, locked: true, segments: [] }],
    }),
  },
  { comando: "aparar", codigo: "CORTE_MUITO_CURTO", args: (c) => ({ clipeId: c.video, lado: "inicio", tempo: 10 }) },
  { comando: "aparar", codigo: "CORTE_MUITO_CURTO", args: (c) => ({ clipeId: c.video, lado: "fim", tempo: 0 }) },
  { comando: "dividir", codigo: "CORTE_FORA_DO_CLIPE", args: (c) => ({ clipeId: c.video, tempo: 15 }) },
  { comando: "dividir", codigo: "CORTE_MUITO_CURTO", args: (c) => ({ clipeId: c.video, tempo: 0.001 }) },
  {
    comando: "duplicar",
    codigo: "MATERIAL_NAO_ENCONTRADO",
    args: (c) => ({ clipeId: c.foto }),
    preparo: (c) => {
      const { retrato: _, ...materials } = c.projeto.materials;
      return { ...c.projeto, materials };
    },
  },
  { comando: "definirVelocidade", codigo: "ARGUMENTO_INVALIDO", args: (c) => ({ clipeId: c.video, velocidade: 50 }) },
  { comando: "definirVelocidade", codigo: "PROPRIEDADE_NAO_SUPORTADA", args: (c) => ({ clipeId: c.foto, velocidade: 2 }) },
  { comando: "congelarQuadro", codigo: "PROPRIEDADE_NAO_SUPORTADA", args: (c) => ({ clipeId: c.foto, tempo: 21 }) },
  { comando: "congelarQuadro", codigo: "CORTE_FORA_DO_CLIPE", args: (c) => ({ clipeId: c.video, tempo: 15 }) },
  { comando: "definirPropriedade", codigo: "PROPRIEDADE_NAO_SUPORTADA", args: (c) => ({ clipeId: c.video, propriedade: "nada", valor: 1 }) },
  { comando: "definirPropriedade", codigo: "PROPRIEDADE_NAO_SUPORTADA", args: (c) => ({ clipeId: c.musica, propriedade: "x", valor: 1 }) },
  { comando: "definirPropriedade", codigo: "PROPRIEDADE_NAO_SUPORTADA", args: (c) => ({ clipeId: c.texto, propriedade: "brightness", valor: 1 }) },
  { comando: "definirPropriedade", codigo: "ARGUMENTO_INVALIDO", args: (c) => ({ clipeId: c.video, propriedade: "brightness", valor: 200 }) },
  { comando: "definirPropriedade", codigo: "ARGUMENTO_INVALIDO", args: (c) => ({ clipeId: c.video, propriedade: "brightness", valor: 10 }), preparo: animada },
  { comando: "definirPropriedade", codigo: "ARGUMENTO_INVALIDO", args: (c) => ({ clipeId: c.video, propriedade: "brightness", valor: 10, tempo: 15 }), preparo: animada },
  { comando: "definirKeyframe", codigo: "PROPRIEDADE_NAO_SUPORTADA", args: (c) => ({ clipeId: c.video, propriedade: "nada", tempo: 1 }) },
  { comando: "definirKeyframe", codigo: "ARGUMENTO_INVALIDO", args: (c) => ({ clipeId: c.video, propriedade: "x", tempo: 15 }) },
  { comando: "definirKeyframe", codigo: "ARGUMENTO_INVALIDO", args: (c) => ({ clipeId: c.video, propriedade: "brightness", tempo: 1, valor: 500 }) },
  { comando: "removerKeyframe", codigo: "PROPRIEDADE_NAO_SUPORTADA", args: (c) => ({ clipeId: c.video, propriedade: "nada", tempo: 1 }) },
  { comando: "removerKeyframe", codigo: "ARGUMENTO_INVALIDO", args: (c) => ({ clipeId: c.video, propriedade: "brightness", tempo: 1 }), preparo: animada },
  { comando: "removerMarcador", codigo: "ARGUMENTO_INVALIDO", args: () => ({ marcadorId: "nada" }), preparo: comMarcador },
  { comando: "definirSuavizacao", codigo: "ARGUMENTO_INVALIDO", args: (c) => ({ clipeId: c.video, suavizacao: "torta" }), preparo: animada },
  { comando: "definirSuavizacao", codigo: "ARGUMENTO_INVALIDO", args: (c) => ({ clipeId: c.video, suavizacao: "in", tempo: 1 }), preparo: animada },
  { comando: "definirRecorte", codigo: "PROPRIEDADE_NAO_SUPORTADA", args: (c) => ({ clipeId: c.texto, borda: "left", valor: 0.2 }) },
  { comando: "definirRecorte", codigo: "ARGUMENTO_INVALIDO", args: (c) => ({ clipeId: c.video, borda: "meio", valor: 0.2 }) },
  { comando: "adicionarTexto", codigo: "ARGUMENTO_INVALIDO", args: () => ({ texto: "  ", inicio: 0, duracao: 1 }) },
  { comando: "adicionarTexto", codigo: "ARGUMENTO_INVALIDO", args: () => ({ texto: "A", inicio: 0, duracao: 0 }) },
  { comando: "adicionarTexto", codigo: "TIPO_DE_FAIXA_INCOMPATIVEL", args: (c) => ({ texto: "A", inicio: 0, duracao: 1, faixaId: c.faixaVideo }) },
  {
    comando: "adicionarTexto",
    codigo: "FAIXA_BLOQUEADA",
    args: (c) => ({ texto: "A", inicio: 0, duracao: 1, faixaId: c.faixaTexto }),
    preparo: (c) => updateTrack(c.projeto, c.faixaTexto, { locked: true }),
  },
  { comando: "definirTexto", codigo: "ARGUMENTO_INVALIDO", args: () => ({ texto: "A" }) },
  { comando: "definirTexto", codigo: "ARGUMENTO_INVALIDO", args: (c) => ({ clipeId: c.texto, materialId: c.textoMaterial, texto: "A" }) },
  { comando: "definirTexto", codigo: "MATERIAL_NAO_ENCONTRADO", args: () => ({ materialId: "nada", texto: "A" }) },
  { comando: "definirTexto", codigo: "PROPRIEDADE_NAO_SUPORTADA", args: () => ({ materialId: "filme", texto: "A" }) },
  {
    comando: "definirTexto",
    codigo: "FAIXA_BLOQUEADA",
    args: (c) => ({ materialId: c.textoMaterial, texto: "A" }),
    preparo: (c) => updateTrack(c.projeto, c.faixaTexto, { locked: true }),
  },
  {
    comando: "substituirTexto",
    codigo: "FAIXA_BLOQUEADA",
    args: () => ({ de: "Retalo", para: "Retalho" }),
    preparo: (c) => updateTrack(c.projeto, c.faixaTexto, { locked: true }),
  },
  { comando: "substituirTexto", codigo: "ARGUMENTO_INVALIDO", args: () => ({ de: "", para: "A" }) },
  { comando: "definirVolume", codigo: "ARGUMENTO_INVALIDO", args: (c) => ({ clipeId: c.video, volume: 99 }) },
  { comando: "definirVolume", codigo: "PROPRIEDADE_NAO_SUPORTADA", args: (c) => ({ clipeId: c.foto, volume: 1 }) },
  { comando: "cortarTrechos", codigo: "ARGUMENTO_INVALIDO", args: (c) => ({ clipeId: c.video, trechos: [{ inicio: 2, fim: 1 }] }) },
  { comando: "cortarTrechos", codigo: "ARGUMENTO_INVALIDO", args: (c) => ({ clipeId: c.video, trechos: [] }) },
  { comando: "cortarTrechos", codigo: "CORTE_FORA_DO_CLIPE", args: (c) => ({ clipeId: c.video, trechos: [{ inicio: 20, fim: 21 }] }) },
  { comando: "cortarTrechos", codigo: "PROPRIEDADE_NAO_SUPORTADA", args: (c) => ({ clipeId: c.foto, trechos: [{ inicio: 0, fim: 1 }] }) },
  { comando: "marcar", codigo: "ARGUMENTO_INVALIDO", args: () => ({ tempo: -1 }) },
  { comando: "marcar", codigo: "ARGUMENTO_INVALIDO", args: () => ({ tempo: 1, rotulo: " " }) },
  { comando: "definirMascara", codigo: "ARGUMENTO_INVALIDO", args: (c) => ({ clipeId: c.video, mascara: { ...MASCARA, shape: "lua" } }) },
  { comando: "definirMascara", codigo: "PROPRIEDADE_NAO_SUPORTADA", args: (c) => ({ clipeId: c.musica, mascara: MASCARA }) },
  { comando: "definirChroma", codigo: "ARGUMENTO_INVALIDO", args: (c) => ({ clipeId: c.video, chroma: { ...CHROMA, color: "verde" } }) },
  { comando: "definirChroma", codigo: "PROPRIEDADE_NAO_SUPORTADA", args: (c) => ({ clipeId: c.texto, chroma: CHROMA }) },
  { comando: "definirEfeito", codigo: "ARGUMENTO_INVALIDO", args: (c) => ({ clipeId: c.video, efeito: "blur", valor: 2 }) },
  { comando: "definirEfeito", codigo: "PROPRIEDADE_NAO_SUPORTADA", args: (c) => ({ clipeId: c.texto, efeito: "blur", valor: 0.5 }) },
  {
    comando: "definirEfeito",
    codigo: "ARGUMENTO_INVALIDO",
    args: (c) => ({ clipeId: c.video, efeito: "blur", valor: 0.5 }),
    preparo: (c) => sucesso(executarComando(c.projeto, "definirKeyframe", { clipeId: c.video, propriedade: "blur", tempo: 1 })).projeto,
  },
  { comando: "definirHsl", codigo: "ARGUMENTO_INVALIDO", args: (c) => ({ clipeId: c.video, cor: "red", ajuste: { ...HSL, hue: 300 } }) },
  { comando: "definirHsl", codigo: "PROPRIEDADE_NAO_SUPORTADA", args: (c) => ({ clipeId: c.texto, cor: "red", ajuste: HSL }) },
  { comando: "definirCurvas", codigo: "ARGUMENTO_INVALIDO", args: (c) => ({ clipeId: c.video, canal: "master", pontos: [[0, 0]] }) },
  { comando: "definirCurvas", codigo: "PROPRIEDADE_NAO_SUPORTADA", args: (c) => ({ clipeId: c.texto, canal: "master", pontos: [[0, 0], [1, 1]] }) },
  { comando: "definirLut", codigo: "MATERIAL_NAO_ENCONTRADO", args: (c) => ({ clipeId: c.video, lutId: "nada" }) },
  { comando: "definirLut", codigo: "ARGUMENTO_INVALIDO", args: (c) => ({ clipeId: c.video, lutId: "lut1", forca: 3 }) },
  { comando: "definirLut", codigo: "PROPRIEDADE_NAO_SUPORTADA", args: (c) => ({ clipeId: c.texto, lutId: "lut1" }) },
  { comando: "cortarPausas", codigo: "ARGUMENTO_INVALIDO", args: (c) => ({ clipeId: c.video, minimo: 0 }), preparo: comPausas },
  { comando: "cortarPausas", codigo: "ARGUMENTO_INVALIDO", args: (c) => ({ clipeId: c.video }) },
  { comando: "cortarPausas", codigo: "PROPRIEDADE_NAO_SUPORTADA", args: (c) => ({ clipeId: c.foto }) },
  { comando: "analisarCenas", codigo: "FORA_DA_FONTE", args: (c) => ({ clipeId: c.video, cenas: [1, 11] }) },
  { comando: "analisarCenas", codigo: "ARGUMENTO_INVALIDO", args: (c) => ({ clipeId: c.video, cenas: [3, 2] }) },
  { comando: "analisarCenas", codigo: "ARGUMENTO_INVALIDO", args: (c) => ({ clipeId: c.video, cenas: [2, 2] }) },
  { comando: "analisarCenas", codigo: "ARGUMENTO_INVALIDO", args: (c) => ({ clipeId: c.video, cenas: [-1] }) },
  { comando: "analisarCenas", codigo: "PROPRIEDADE_NAO_SUPORTADA", args: (c) => ({ clipeId: c.foto, cenas: [1] }) },
  { comando: "analisarPausas", codigo: "FORA_DA_FONTE", args: (c) => ({ clipeId: c.video, pausas: [{ inicio: 9, fim: 12 }] }) },
  { comando: "analisarPausas", codigo: "ARGUMENTO_INVALIDO", args: (c) => ({ clipeId: c.video, pausas: [{ inicio: 2, fim: 1 }] }) },
  { comando: "analisarPausas", codigo: "ARGUMENTO_INVALIDO", args: (c) => ({ clipeId: c.video, pausas: [{ inicio: 1, fim: 3 }, { inicio: 2, fim: 4 }] }) },
  { comando: "analisarBatidas", codigo: "FORA_DA_FONTE", args: (c) => ({ clipeId: c.video, batidas: [20] }) },
  { comando: "analisarBatidas", codigo: "ARGUMENTO_INVALIDO", args: (c) => ({ clipeId: c.video, batidas: [2, 1] }) },
  { comando: "analisarLoudness", codigo: "ARGUMENTO_INVALIDO", args: (c) => ({ clipeId: c.video, loudness: { integrado: -80, pico: -1 } }) },
  { comando: "analisarLoudness", codigo: "ARGUMENTO_INVALIDO", args: (c) => ({ clipeId: c.video, loudness: { integrado: 1, pico: -1 } }) },
  { comando: "analisarLoudness", codigo: "ARGUMENTO_INVALIDO", args: (c) => ({ clipeId: c.video, loudness: { integrado: -14, pico: -130 } }) },
  { comando: "analisarLoudness", codigo: "ARGUMENTO_INVALIDO", args: (c) => ({ clipeId: c.video, loudness: { integrado: -14, pico: 1 } }) },
  { comando: "transcrever", codigo: "FORA_DA_FONTE", args: (c) => ({ clipeId: c.video, palavras: [{ text: "oi", start: 9, end: 11 }] }) },
  { comando: "transcrever", codigo: "ARGUMENTO_INVALIDO", args: (c) => ({ clipeId: c.video, palavras: [{ text: "oi", start: 2, end: 2 }] }) },
  { comando: "transcrever", codigo: "ARGUMENTO_INVALIDO", args: (c) => ({ clipeId: c.video, palavras: [{ text: " ", start: 1, end: 2 }] }) },
  { comando: "transcrever", codigo: "ARGUMENTO_INVALIDO", args: (c) => ({ clipeId: c.video, palavras: [{ start: 1, end: 2 }] }) },
  { comando: "adicionarClipe", codigo: "ARGUMENTO_INVALIDO", args: () => ({ materialId: "filme", inicio: 0, duracao: 0 }) },
  { comando: "definirProjeto", codigo: "ARGUMENTO_INVALIDO", args: () => ({ largura: 1080.5 }) },
  { comando: "definirProjeto", codigo: "ARGUMENTO_INVALIDO", args: () => ({ fundo: "azul" }) },
  { comando: "criarFaixa", codigo: "ARGUMENTO_INVALIDO", args: () => ({ tipo: "legenda" }) },
  { comando: "adicionarForma", codigo: "ARGUMENTO_INVALIDO", args: () => ({ forma: "lua", inicio: 0, duracao: 1 }) },
  { comando: "adicionarForma", codigo: "TIPO_DE_FAIXA_INCOMPATIVEL", args: (c) => ({ forma: "circle", inicio: 0, duracao: 1, faixaId: c.faixaVideo }) },
  { comando: "estilizar", codigo: "ARGUMENTO_INVALIDO", args: (c) => ({ clipeId: c.texto, estilo: { tamanho: 3 } }) },
  { comando: "estilizar", codigo: "ARGUMENTO_INVALIDO", args: (c) => ({ clipeId: c.texto, estilo: { color: "amarelo" } }) },
  { comando: "estilizar", codigo: "ARGUMENTO_INVALIDO", args: (c) => ({ clipeId: c.texto, materialId: c.textoMaterial, estilo: {} }) },
  { comando: "estilizar", codigo: "ARGUMENTO_INVALIDO", args: (c) => ({ clipeId: c.texto, estilo: { spoken: { mode: "highlight", color: "#ffffff", scale: 3 } } }) },
  { comando: "estilizar", codigo: "PROPRIEDADE_NAO_SUPORTADA", args: (c) => ({ clipeId: c.video, estilo: { color: "#ffffff" } }) },
  { comando: "estilizar", codigo: "MATERIAL_NAO_ENCONTRADO", args: () => ({ materialId: "nada", estilo: {} }) },
  { comando: "definirAnimacao", codigo: "ARGUMENTO_INVALIDO", args: (c) => ({ clipeId: c.texto, entrada: { tipo: "voar", duracao: 1 } }) },
  { comando: "definirAnimacao", codigo: "ARGUMENTO_INVALIDO", args: (c) => ({ clipeId: c.texto, saida: { tipo: "pop", duracao: 1 } }) },
  { comando: "definirAnimacao", codigo: "PROPRIEDADE_NAO_SUPORTADA", args: (c) => ({ clipeId: c.musica, entrada: { tipo: "fade", duracao: 1 } }) },
  { comando: "definirMoldura", codigo: "ARGUMENTO_INVALIDO", args: (c) => ({ clipeId: c.foto, moldura: { ...MOLDURA, radius: 2 } }) },
  { comando: "definirMoldura", codigo: "PROPRIEDADE_NAO_SUPORTADA", args: (c) => ({ clipeId: c.texto, moldura: MOLDURA }) },
  { comando: "definirEnquadramento", codigo: "ARGUMENTO_INVALIDO", args: (c) => ({ clipeId: c.foto, enquadramento: "esticar" }) },
  { comando: "definirEnquadramento", codigo: "PROPRIEDADE_NAO_SUPORTADA", args: (c) => ({ clipeId: c.texto, enquadramento: "cover" }) },
  { comando: "definirFades", codigo: "PROPRIEDADE_NAO_SUPORTADA", args: (c) => ({ clipeId: c.foto, entrada: 1 }) },
  { comando: "definirFades", codigo: "ARGUMENTO_INVALIDO", args: (c) => ({ clipeId: c.musica, entrada: -1 }) },
  { comando: "definirEfeitosDeAudio", codigo: "ARGUMENTO_INVALIDO", args: (c) => ({ clipeId: c.musica, efeitos: { ...EFEITOS_AUDIO, low: 40 } }) },
  { comando: "definirEfeitosDeAudio", codigo: "PROPRIEDADE_NAO_SUPORTADA", args: (c) => ({ clipeId: c.texto, efeitos: EFEITOS_AUDIO }) },
  { comando: "definirTransformacao", codigo: "ARGUMENTO_INVALIDO", args: (c) => ({ clipeId: c.texto, opacidade: 2 }) },
  {
    comando: "definirTransformacao",
    codigo: "ARGUMENTO_INVALIDO",
    args: (c) => ({ clipeId: c.video, x: 0.5 }),
    preparo: (c) => sucesso(executarComando(c.projeto, "definirKeyframe", { clipeId: c.video, propriedade: "x", tempo: 1 })).projeto,
  },
  { comando: "definirTransformacao", codigo: "PROPRIEDADE_NAO_SUPORTADA", args: (c) => ({ clipeId: c.musica, x: 0.5 }) },
  { comando: "adicionarLegendas", codigo: "ARGUMENTO_INVALIDO", args: () => ({ palavras: [] }) },
  { comando: "adicionarLegendas", codigo: "ARGUMENTO_INVALIDO", args: () => ({ palavras: [{ texto: "oi", inicio: 2, fim: 1 }] }) },
  { comando: "adicionarLegendas", codigo: "ARGUMENTO_INVALIDO", args: () => ({ palavras: PALAVRAS_DITAS, destaque: { cor: "#ffd23f", escala: 4 } }) },
  { comando: "adicionarLegendas", codigo: "ARGUMENTO_INVALIDO", args: () => ({ palavras: PALAVRAS_DITAS, estilo: { fontSize: 0 } }) },
  { comando: "adicionarLegendas", codigo: "TIPO_DE_FAIXA_INCOMPATIVEL", args: (c) => ({ palavras: PALAVRAS_DITAS, faixaId: c.faixaVideo }) },
];

/** Names the argument, what came in and what is accepted. */
function confereMensagem(comando: string, mensagem: string) {
  expect(mensagem).toMatch(/^[\w.[\]]+: recebido .+, esperado .+/);
  const argumento = mensagem.split(":")[0]!.split(/[.[]/)[0]!;
  expect(Object.keys(ESQUEMA[comando]!.argumentos)).toContain(argumento);
}

describe("cada comando", () => {
  it("o esquema e a tabela de testes cobrem os mesmos comandos", () => {
    expect(SUCESSOS.map(({ comando }) => comando).sort()).toEqual(Object.keys(ESQUEMA).sort());
  });

  for (const { comando, args, preparo } of SUCESSOS) {
    it(`${comando} altera o projeto e diz o que mudou`, () => {
      const c = cena();
      const projeto = preparo?.(c) ?? c.projeto;
      const resultado = sucesso(executarComando(projeto, comando, args(c)));
      expect(resultado.alterado).toBe(true);
      expect(resultado.afetados.length).toBeGreaterThan(0);
    });

    it(`${comando} não muda o projeto de entrada`, () => {
      const c = cena();
      const projeto = preparo?.(c) ?? c.projeto;
      const antes = structuredClone(projeto);
      executarComando(projeto, comando, args(c));
      expect(projeto).toEqual(antes);
    });

    it(`${comando} recusa argumento desconhecido`, () => {
      const c = cena();
      const resultado = executarComando(c.projeto, comando, { ...args(c), sobrando: 1 });
      expect(resultado).toMatchObject({ ok: false, codigo: "ARGUMENTO_INVALIDO" });
      expect(!resultado.ok && resultado.mensagem).toMatch(/^sobrando: recebido 1, esperado /);
    });

    for (const [nome, regra] of Object.entries(ESQUEMA[comando]!.argumentos)) {
      if (!regra.obrigatorio) continue;
      it(`${comando} exige ${nome}`, () => {
        const c = cena();
        const { [nome]: _, ...resto } = args(c);
        const resultado = executarComando(c.projeto, comando, resto);
        expect(resultado).toMatchObject({ ok: false, codigo: "ARGUMENTO_INVALIDO" });
        expect(!resultado.ok && resultado.mensagem).toMatch(new RegExp(`^${nome}: recebido nada, esperado `));
      });
    }

    if (!("clipeId" in args(cena()))) continue;

    it(`${comando} avisa quando o clipe não existe`, () => {
      const c = cena();
      expect(executarComando(c.projeto, comando, { ...args(c), clipeId: "nada" })).toMatchObject({ ok: false, codigo: "CLIPE_NAO_ENCONTRADO" });
    });

    // Captions go to a new track, so a locked source clip stays as it is.
    if (comando === "criarLegendas") continue;

    it(`${comando} respeita a faixa bloqueada`, () => {
      const c = cena();
      const alvo = args(c).clipeId as string;
      const base = preparo?.(c) ?? c.projeto;
      const bloqueado = updateTrack(base, findSegment(base, alvo)!.track.id, { locked: true });
      expect(executarComando(bloqueado, comando, args(c))).toMatchObject({ ok: false, codigo: "FAIXA_BLOQUEADA" });
    });
  }

  for (const [index, { comando, codigo, args, preparo }] of ERROS.entries()) {
    it(`${comando} devolve ${codigo} (caso ${index + 1})`, () => {
      const c = cena();
      const projeto = preparo?.(c) ?? c.projeto;
      const antes = structuredClone(projeto);
      const resultado = executarComando(projeto, comando, args(c));
      expect(resultado).toMatchObject({ ok: false, codigo });
      expect(projeto).toEqual(antes);
      if (codigo === "ARGUMENTO_INVALIDO" && !resultado.ok) confereMensagem(comando, resultado.mensagem);
    });
  }

  it("recusa comando desconhecido, inclusive nomes herdados de Object", () => {
    const { projeto } = cena();
    expect(executarComando(projeto, "voar", {})).toMatchObject({ ok: false, codigo: "COMANDO_DESCONHECIDO" });
    expect(executarComando(projeto, "toString", {})).toMatchObject({ ok: false, codigo: "COMANDO_DESCONHECIDO" });
  });

  it("recusa argumentos que não são um objeto", () => {
    expect(conferirArgumentos("marcar", [1])).toBe("args: recebido [1], esperado objeto com os argumentos do comando");
    expect(executarComando(cena().projeto, "marcar", null)).toMatchObject({ ok: false, codigo: "ARGUMENTO_INVALIDO" });
  });
});

describe("avisos com o valor efetivo", () => {
  it("adicionarClipe vai ao espaço livre", () => {
    const c = cena();
    const { avisos } = sucesso(executarComando(c.projeto, "adicionarClipe", { materialId: "filme", inicio: 5, faixaId: c.faixaVideo }));
    expect(avisos[0]).toContain("pedido 5, efetivo 10");
  });

  it("moverClipe vai ao espaço livre", () => {
    const c = cena();
    const { avisos, projeto } = sucesso(executarComando(c.projeto, "moverClipe", { clipeId: c.foto, inicio: 5, faixaId: c.faixaVideo }));
    expect(avisos[0]).toContain("pedido 5, efetivo 10");
    expect(clipe(projeto, c.foto).target.start).toBe(10 * S);
  });

  it("aparar para na fonte", () => {
    const c = cena();
    const { avisos } = sucesso(executarComando(c.projeto, "aparar", { clipeId: c.video, lado: "fim", tempo: 15 }));
    expect(avisos[0]).toContain("pedido 15, efetivo 10");
  });

  it("definirRecorte para na borda oposta", () => {
    const c = cena();
    const um = sucesso(executarComando(c.projeto, "definirRecorte", { clipeId: c.video, borda: "left", valor: 0.9 }));
    const { avisos } = sucesso(executarComando(um.projeto, "definirRecorte", { clipeId: c.video, borda: "right", valor: 0.5 }));
    expect(avisos[0]).toMatch(/pedido 0\.5, efetivo 0\.05/);
  });

  it("cortarTrechos limita ao clipe", () => {
    const c = cena();
    const { avisos } = sucesso(executarComando(c.projeto, "cortarTrechos", { clipeId: c.video, trechos: [{ inicio: 8, fim: 12 }] }));
    expect(avisos[0]).toContain("efetivo 8-10");
  });

  it("adicionarTexto vai ao espaço livre", () => {
    const c = cena();
    const { avisos } = sucesso(executarComando(c.projeto, "adicionarTexto", { texto: "A", inicio: 1, duracao: 1, faixaId: c.faixaTexto }));
    expect(avisos[0]).toContain("pedido 1, efetivo 5");
  });

  it("dividir alinha ao quadro", () => {
    const c = cena();
    const { avisos, projeto } = sucesso(executarComando(c.projeto, "dividir", { clipeId: c.video, tempo: 2.51 }));
    expect(avisos[0]).toContain("pedido 2.51, efetivo 2.5");
    expect(clipe(projeto, c.video).target.duration).toBe(2.5 * S);
  });

  it("dividir num quadro exato não avisa", () => {
    const c = cena();
    for (const tempo of [1, 5, 9]) expect(sucesso(executarComando(c.projeto, "dividir", { clipeId: c.video, tempo })).avisos).toEqual([]);
  });

  it("definirPropriedade avisa que ignorou o tempo", () => {
    const c = cena();
    const { avisos } = sucesso(executarComando(c.projeto, "definirPropriedade", { clipeId: c.video, propriedade: "x", valor: 1, tempo: 2 }));
    expect(avisos[0]).toContain("ignorado");
  });

  it("definirVolume avisa em vídeo sem som", () => {
    const c = cena();
    const projeto = { ...c.projeto, materials: { ...c.projeto.materials, filme: media("filme", "video", 10, false) } };
    expect(sucesso(executarComando(projeto, "definirVolume", { clipeId: c.video, volume: 1.5 })).avisos[0]).toContain("não tem som");
  });
});

describe("mensagens de argumento inválido", () => {
  const mensagem = (comando: string, args: unknown) => {
    const resultado = executarComando(cena().projeto, comando, args);
    return !resultado.ok && resultado.mensagem;
  };

  it("segue o formato pedido", () => {
    expect(mensagem("marcar", { tempo: -1 })).toBe("tempo: recebido -1, esperado número maior ou igual a 0");
  });

  it("mostra limites e opções", () => {
    const c = cena();
    expect(executarComando(c.projeto, "definirVelocidade", { clipeId: c.video, velocidade: 50 })).toMatchObject({
      mensagem: "velocidade: recebido 50, esperado número maior ou igual a 0.1 e menor ou igual a 10",
    });
    expect(executarComando(c.projeto, "aparar", { clipeId: c.video, lado: "meio", tempo: 1 })).toMatchObject({
      mensagem: 'lado: recebido "meio", esperado um de: inicio, fim',
    });
  });

  it("aponta o campo dentro de um objeto ou lista", () => {
    const c = cena();
    expect(executarComando(c.projeto, "definirMascara", { clipeId: c.video, mascara: { ...MASCARA, width: 0 } })).toMatchObject({
      mensagem: "mascara.width: recebido 0, esperado número maior que 0",
    });
    expect(executarComando(c.projeto, "cortarTrechos", { clipeId: c.video, trechos: [{ inicio: 1, fim: 2 }, { inicio: 3, fim: 1 }] })).toMatchObject({
      mensagem: expect.stringMatching(/^trechos\[1\]: recebido /),
    });
  });
});

describe("idempotência", () => {
  it("marcar duas vezes no mesmo tempo não muda nada na segunda", () => {
    const um = sucesso(executarComando(cena().projeto, "marcar", { tempo: 3 }));
    const dois = sucesso(executarComando(um.projeto, "marcar", { tempo: 3 }));
    expect(dois).toMatchObject({ alterado: false, afetados: [] });
    expect(dois.projeto).toBe(um.projeto);
    expect(dois.avisos[0]).toContain("Já existe");
  });

  it("marcar no mesmo quadro, com tempo um pouco diferente, também não cria outro", () => {
    const um = sucesso(executarComando(cena().projeto, "marcar", { tempo: 3 }));
    expect(sucesso(executarComando(um.projeto, "marcar", { tempo: 3.01 })).alterado).toBe(false);
  });

  it("marcar usa o rótulo pedido e, sem ele, numera", () => {
    const um = sucesso(executarComando(cena().projeto, "marcar", { tempo: 3, rotulo: "Gancho" }));
    const dois = sucesso(executarComando(um.projeto, "marcar", { tempo: 1 }));
    expect(dois.projeto.markers!.map(({ label }) => label)).toEqual(["Marcador 01", "Gancho"]);
  });

  it("definirKeyframe duas vezes com o mesmo valor dá o mesmo projeto", () => {
    const c = cena();
    const args = { clipeId: c.video, propriedade: "x", tempo: 1, valor: 0.5 };
    const um = sucesso(executarComando(c.projeto, "definirKeyframe", args));
    const dois = sucesso(executarComando(um.projeto, "definirKeyframe", args));
    expect(dois.alterado).toBe(false);
    expect(dois.projeto).toBe(um.projeto);
  });

  it("definirKeyframe sem valor mantém o keyframe que já existe", () => {
    const c = cena();
    const um = sucesso(executarComando(c.projeto, "definirKeyframe", { clipeId: c.video, propriedade: "x", tempo: 1, valor: 0.5 }));
    const dois = sucesso(executarComando(um.projeto, "definirKeyframe", { clipeId: c.video, propriedade: "x", tempo: 1 }));
    expect(clipe(dois.projeto, c.video).keyframes.x).toHaveLength(1);
    expect(dois.alterado).toBe(false);
  });

  it("definirKeyframe atualiza, avisa e preserva a suavização", () => {
    const c = cena();
    const curva = sucesso(executarComando(animada(c), "definirSuavizacao", { clipeId: c.video, suavizacao: "in" }));
    const { projeto, avisos } = sucesso(executarComando(curva.projeto, "definirKeyframe", { clipeId: c.video, propriedade: "brightness", tempo: 2, valor: -40 }));
    expect(avisos[0]).toContain("atualizado para -40");
    expect(clipe(projeto, c.video).keyframes.brightness![1]).toMatchObject({ value: -40, ease: "in" });
  });

  it("definirKeyframe sem valor usa o valor atual naquele tempo", () => {
    const c = cena();
    const base = sucesso(executarComando(animada(c), "definirPropriedade", { clipeId: c.video, propriedade: "brightness", valor: -100, tempo: 2 }));
    const { projeto } = sucesso(executarComando(base.projeto, "definirKeyframe", { clipeId: c.video, propriedade: "brightness", tempo: 1 }));
    expect(clipe(projeto, c.video).keyframes.brightness![1]).toMatchObject({ offset: S, value: -50 });
  });
});

describe("removerKeyframe e removerMarcador", () => {
  it("remove só o keyframe daquele tempo", () => {
    const c = cena();
    const { projeto } = sucesso(executarComando(animada(c), "removerKeyframe", { clipeId: c.video, propriedade: "brightness", tempo: 2 }));
    expect(clipe(projeto, c.video).keyframes.brightness!.map(({ offset }) => offset)).toEqual([0]);
  });

  it("no tempo errado devolve os tempos existentes, em segundos", () => {
    const c = cena();
    expect(executarComando(animada(c), "removerKeyframe", { clipeId: c.video, propriedade: "brightness", tempo: 1 })).toMatchObject({
      codigo: "ARGUMENTO_INVALIDO",
      mensagem: "tempo: recebido 1, esperado um tempo com keyframe de brightness: 0, 2",
      detalhes: { tempos: [0, 2] },
    });
  });

  it("os tempos da lista estão na timeline", () => {
    const c = cena();
    const um = sucesso(executarComando(c.projeto, "definirKeyframe", { clipeId: c.foto, propriedade: "x", tempo: 21 }));
    expect(executarComando(um.projeto, "removerKeyframe", { clipeId: c.foto, propriedade: "x", tempo: 22 })).toMatchObject({ detalhes: { tempos: [21] } });
  });

  it("sem nenhum keyframe devolve lista vazia", () => {
    const c = cena();
    expect(executarComando(c.projeto, "removerKeyframe", { clipeId: c.video, propriedade: "x", tempo: 1 })).toMatchObject({
      codigo: "ARGUMENTO_INVALIDO",
      detalhes: { tempos: [] },
    });
  });

  it("o último keyframe deixa a propriedade parada no valor dele", () => {
    const c = cena();
    const um = sucesso(executarComando(c.projeto, "definirKeyframe", { clipeId: c.video, propriedade: "contrast", tempo: 1, valor: 70 }));
    const { projeto } = sucesso(executarComando(um.projeto, "removerKeyframe", { clipeId: c.video, propriedade: "contrast", tempo: 1 }));
    expect(clipe(projeto, c.video).keyframes.contrast).toBeUndefined();
    expect(clipe(projeto, c.video).adjust.contrast).toBe(70);
  });

  it("removerMarcador tira pelo id que aparece em inspecionar", () => {
    const um = sucesso(executarComando(cena().projeto, "marcar", { tempo: 3 }));
    const { id } = inspecionar(um.projeto).marcadores[0]!;
    expect(sucesso(executarComando(um.projeto, "removerMarcador", { marcadorId: id })).projeto.markers).toEqual([]);
  });
});

describe("moverClipe com grupo", () => {
  it("move todos os membros e mantém as distâncias", () => {
    const c = cena();
    const { projeto, outra } = agrupada(c);
    const movido = sucesso(executarComando(projeto, "moverClipe", { clipeId: c.foto, inicio: 40 }));
    expect(clipe(movido.projeto, c.foto).target.start).toBe(40 * S);
    expect(clipe(movido.projeto, outra).target.start).toBe(46 * S);
    expect(movido.afetados).toEqual(expect.arrayContaining([c.foto, outra]));
  });

  it("com apenasClipe move só o indicado", () => {
    const c = cena();
    const { projeto, outra } = agrupada(c);
    const movido = sucesso(executarComando(projeto, "moverClipe", { clipeId: c.foto, inicio: 40, apenasClipe: true }));
    expect(clipe(movido.projeto, c.foto).target.start).toBe(40 * S);
    expect(clipe(movido.projeto, outra).target.start).toBe(26 * S);
  });

  it("colisão devolve SOBREPOSICAO com os ids e não altera nada", () => {
    const c = cena();
    const { projeto } = agrupada(c);
    const antes = structuredClone(projeto);
    expect(executarComando(projeto, "moverClipe", { clipeId: c.foto, inicio: 5 })).toMatchObject({
      ok: false,
      codigo: "SOBREPOSICAO",
      detalhes: { conflitos: [c.video] },
    });
    expect(projeto).toEqual(antes);
  });

  it("um membro em faixa bloqueada recusa o grupo inteiro", () => {
    const c = cena();
    const { projeto } = agrupada(c);
    const com = setGroup(projeto, [c.foto, c.texto], "g1");
    const bloqueado = updateTrack(com, c.faixaTexto, { locked: true });
    expect(executarComando(bloqueado, "moverClipe", { clipeId: c.foto, inicio: 40 })).toMatchObject({ codigo: "FAIXA_BLOQUEADA" });
  });

  it("grupo em várias faixas segue junto, cada clipe na sua", () => {
    const c = cena();
    const com = setGroup(c.projeto, [c.foto, c.texto], "g1");
    const { projeto } = sucesso(executarComando(com, "moverClipe", { clipeId: c.foto, inicio: 30 }));
    expect(clipe(projeto, c.texto).target.start).toBe(10 * S);
    expect(findSegment(projeto, c.texto)!.track.id).toBe(c.faixaTexto);
  });

  it("mudar o grupo de faixa pede apenasClipe", () => {
    const c = cena();
    const { projeto } = agrupada(c);
    const outra = addTrack(projeto, "video");
    const resultado = executarComando(outra.project, "moverClipe", { clipeId: c.foto, inicio: 40, faixaId: outra.trackId });
    expect(resultado).toMatchObject({ codigo: "ARGUMENTO_INVALIDO", mensagem: expect.stringContaining("apenasClipe") });
  });

  it("o começo da timeline limita o grupo inteiro, com aviso", () => {
    const c = cena();
    const com = setGroup(c.projeto, [c.foto, c.texto], "g1");
    const antes = sucesso(executarComando(com, "moverClipe", { clipeId: c.foto, inicio: 30 }));
    const { projeto, avisos } = sucesso(executarComando(antes.projeto, "moverClipe", { clipeId: c.foto, inicio: 10 }));
    expect(avisos[0]).toContain("pedido 10, efetivo 20");
    expect(clipe(projeto, c.texto).target.start).toBe(0);
  });

  it("sem faixaId fica na faixa atual", () => {
    const c = cena();
    const { projeto } = sucesso(executarComando(c.projeto, "moverClipe", { clipeId: c.foto, inicio: 30 }));
    expect(findSegment(projeto, c.foto)!.track.id).toBe(c.faixaVideo);
  });
});

describe("válido, sem mudança", () => {
  const semMudanca = (resultado: Resultado) => {
    expect(sucesso(resultado)).toMatchObject({ alterado: false, afetados: [] });
  };

  it("substituirTexto sem ocorrência", () => {
    semMudanca(executarComando(cena().projeto, "substituirTexto", { de: "xyz", para: "abc" }));
  });

  it("definirSuavizacao em clipe sem keyframes", () => {
    const c = cena();
    semMudanca(executarComando(c.projeto, "definirSuavizacao", { clipeId: c.video, suavizacao: "in" }));
  });

  it("definirVolume igual ao atual", () => {
    const c = cena();
    semMudanca(executarComando(c.projeto, "definirVolume", { clipeId: c.video, volume: 1 }));
  });

  it("comandos de fala em clipe sem palavras", () => {
    const c = cena();
    for (const comando of ["cortarHesitacoes", "criarLegendas"]) {
      const resultado = executarComando(c.projeto, comando, { clipeId: c.musica });
      semMudanca(resultado);
      expect(sucesso(resultado).avisos[0]).toContain("transcritas");
    }
  });

  it("remover o que já não existe", () => {
    const c = cena();
    semMudanca(executarComando(c.projeto, "definirMascara", { clipeId: c.video, mascara: null }));
    semMudanca(executarComando(c.projeto, "definirEfeito", { clipeId: c.video, efeito: "blur", valor: null }));
  });
});

describe("resultado de cada comando", () => {
  it("os tempos estão em segundos e o id novo vem primeiro", () => {
    const c = cena();
    const { projeto, afetados } = sucesso(executarComando(c.projeto, "dividir", { clipeId: c.video, tempo: 2.5 }));
    expect(clipe(projeto, c.video).target.duration).toBe(2.5 * S);
    expect(clipe(projeto, afetados[0]!).target.start).toBe(2.5 * S);
    expect(afetados).toContain(c.video);
  });

  it("excluir com fecharEspaco puxa o que vem depois", () => {
    const c = cena();
    const { projeto } = sucesso(executarComando(c.projeto, "excluir", { clipeId: c.video, fecharEspaco: true }));
    expect(clipe(projeto, c.foto).target.start).toBe(10 * S);
  });

  it("adicionarTexto usa a duração pedida e cabe num espaço curto", () => {
    const c = cena();
    const projeto = addTrack(c.projeto, "text").project;
    const faixaId = projeto.tracks.at(-1)!.id;
    const um = sucesso(executarComando(projeto, "adicionarTexto", { texto: "A", inicio: 0, duracao: 1, faixaId }));
    const dois = sucesso(executarComando(um.projeto, "adicionarTexto", { texto: "B", inicio: 3, duracao: 1, faixaId }));
    const tres = sucesso(executarComando(dois.projeto, "adicionarTexto", { texto: "C", inicio: 1, duracao: 2, faixaId }));
    expect(tres.avisos).toEqual([]);
    expect(clipe(tres.projeto, tres.afetados.find((id) => findSegment(tres.projeto, id))!).target).toEqual({ start: S, duration: 2 * S });
  });

  it("definirPropriedade grava keyframe em propriedade animada", () => {
    const c = cena();
    const { projeto } = sucesso(executarComando(animada(c), "definirPropriedade", { clipeId: c.video, propriedade: "brightness", valor: -100, tempo: 2 }));
    expect(clipe(projeto, c.video).keyframes.brightness![1]).toMatchObject({ offset: 2 * S, value: -100 });
  });

  it("definirSuavizacao muda só o keyframe do tempo", () => {
    const c = cena();
    const { projeto } = sucesso(executarComando(animada(c), "definirSuavizacao", { clipeId: c.video, suavizacao: "bounce", tempo: 0 }));
    expect(clipe(projeto, c.video).keyframes.brightness!.map(({ ease }) => ease)).toEqual(["bounce", undefined]);
  });

  it("definirEfeito com null remove o efeito e seus keyframes", () => {
    const c = cena();
    const animado = sucesso(executarComando(c.projeto, "definirKeyframe", { clipeId: c.video, propriedade: "blur", tempo: 1 }));
    const { projeto } = sucesso(executarComando(animado.projeto, "definirEfeito", { clipeId: c.video, efeito: "blur", valor: null }));
    expect(clipe(projeto, c.video).keyframes.blur).toBeUndefined();
  });

  it("cortarPausas corta só as pausas acima do mínimo, com margem", () => {
    const c = cena();
    const { projeto } = sucesso(executarComando(comPausas(c), "cortarPausas", { clipeId: c.video, minimo: 0.5 }));
    const pedacos = findSegment(projeto, c.video)!.track.segments;
    expect(pedacos[0]!.source.duration).toBe(1.08 * S);
    expect(pedacos[1]!.source.start).toBe(1.92 * S);
    // The 0.3 second pause at 4 stays in.
    expect(pedacos[1]!.source.duration).toBe(8.08 * S);
  });

  it("cortarPausas com mínimo menor corta também a pausa curta", () => {
    const c = cena();
    const { projeto } = sucesso(executarComando(comPausas(c), "cortarPausas", { clipeId: c.video, minimo: 0.2 }));
    expect(findSegment(projeto, c.video)!.track.segments.filter((segment) => segment.materialId === "filme")).toHaveLength(3);
  });

  it("cortarPausas sem análise pede analisarPausas e não mede nada", () => {
    const c = cena();
    const resultado = executarComando(c.projeto, "cortarPausas", { clipeId: c.video });
    expect(resultado).toMatchObject({ ok: false, codigo: "ARGUMENTO_INVALIDO", mensagem: expect.stringContaining("analisarPausas") });
  });

  it("cortarPausas corta o silêncio até a ponta do clipe e mantém a margem só do lado da fala", () => {
    const c = cena();
    const analisado = sucesso(executarComando(c.projeto, "analisarPausas", { clipeId: c.video, pausas: [{ inicio: 0, fim: 1 }, { inicio: 9, fim: 10 }] }));
    const { projeto } = sucesso(executarComando(analisado.projeto, "cortarPausas", { clipeId: c.video }));
    const [pedaco] = findSegment(projeto, findSegment(projeto, c.foto)!.segment.id)!.track.segments.filter((segment) => segment.materialId === "filme");
    expect(pedaco!.source).toEqual({ start: 0.92 * S, duration: 8.16 * S });
  });

  it("cortarPausas com análise vazia não muda nada", () => {
    const c = cena();
    const analisado = sucesso(executarComando(c.projeto, "analisarPausas", { clipeId: c.video, pausas: [] }));
    expect(sucesso(executarComando(analisado.projeto, "cortarPausas", { clipeId: c.video }))).toMatchObject({ alterado: false });
  });

  it("cortarHesitacoes tira só a hesitação", () => {
    const c = cena();
    const { projeto } = sucesso(executarComando(c.projeto, "cortarHesitacoes", { clipeId: c.video }));
    expect(findSegment(projeto, c.video)!.track.segments[0]!.source.duration).toBe(0.6 * S);
  });

  it("criarLegendas guarda o tempo das palavras", () => {
    const c = cena();
    const { projeto, afetados } = sucesso(executarComando(c.projeto, "criarLegendas", { clipeId: c.video }));
    const legenda = Object.values(projeto.materials).find((material) => material.kind === "text" && material.text.startsWith("bom"));
    expect(legenda).toMatchObject({ timing: expect.any(Array) });
    expect(afetados.length).toBeGreaterThan(1);
  });
});

describe("análise do material", () => {
  const CASOS: [string, (c: Cena) => Record<string, unknown>][] = [
    ["analisarCenas", (c) => ({ clipeId: c.video, cenas: [1, 4.5] })],
    ["analisarPausas", (c) => ({ clipeId: c.video, pausas: [{ inicio: 1, fim: 2 }] })],
    ["analisarBatidas", (c) => ({ clipeId: c.video, batidas: [0.5, 1] })],
    ["analisarLoudness", (c) => ({ clipeId: c.video, loudness: LOUDNESS })],
    ["transcrever", (c) => ({ clipeId: c.video, palavras: [{ text: "oi", start: 1, end: 1.5 }] })],
  ];

  for (const [comando, args] of CASOS) {
    it(`${comando} repetido com o mesmo valor dá o mesmo projeto`, () => {
      const c = cena();
      const um = sucesso(executarComando(c.projeto, comando, args(c)));
      const dois = sucesso(executarComando(um.projeto, comando, args(c)));
      expect(dois).toMatchObject({ alterado: false, afetados: [] });
      expect(dois.projeto).toBe(um.projeto);
    });
  }

  it("grava em tempo da fonte, em microssegundos, com versão e data", () => {
    const c = cena();
    const { projeto } = sucesso(executarComando(c.projeto, "analisarCenas", { clipeId: c.video, cenas: [1, 4.5] }));
    const { analise } = clipe(projeto, c.video);
    expect(analise).toMatchObject({ versao: 1, cenas: [S, 4.5 * S] });
    expect(new Date(analise!.geradoEm).toISOString()).toBe(analise!.geradoEm);
  });

  it("um campo novo mantém os que já existem", () => {
    const c = cena();
    const um = sucesso(executarComando(c.projeto, "analisarCenas", { clipeId: c.video, cenas: [1] }));
    const { projeto } = sucesso(executarComando(um.projeto, "analisarLoudness", { clipeId: c.video, loudness: LOUDNESS }));
    expect(clipe(projeto, c.video).analise).toMatchObject({ cenas: [S], loudness: LOUDNESS });
  });

  it("analisarBatidas espelha em beats", () => {
    const c = cena();
    const { projeto } = sucesso(executarComando(c.projeto, "analisarBatidas", { clipeId: c.video, batidas: [0.5, 1] }));
    expect(clipe(projeto, c.video).beats).toEqual([0.5 * S, S]);
    expect(clipe(projeto, c.video).analise!.batidas).toEqual([0.5 * S, S]);
  });

  it("analisarPausas guarda em ordem, aceita pausas encostadas e lista vazia", () => {
    const c = cena();
    const { projeto } = sucesso(executarComando(c.projeto, "analisarPausas", { clipeId: c.video, pausas: [{ inicio: 3, fim: 4 }, { inicio: 1, fim: 3 }] }));
    expect(clipe(projeto, c.video).analise!.pausas).toEqual([{ inicio: S, fim: 3 * S }, { inicio: 3 * S, fim: 4 * S }]);
    expect(sucesso(executarComando(c.projeto, "analisarPausas", { clipeId: c.video, pausas: [] })).alterado).toBe(true);
  });

  it("transcrever grava no formato de words", () => {
    const c = cena();
    const { projeto } = sucesso(executarComando(c.projeto, "transcrever", { clipeId: c.video, palavras: [{ text: "oi", start: 1, end: 1.5 }] }));
    expect(clipe(projeto, c.video).words).toEqual([{ text: "oi", start: S, end: 1.5 * S }]);
  });

  it("os limites são os da fonte do clipe, não da timeline", () => {
    const c = cena();
    const aparado = sucesso(executarComando(c.projeto, "aparar", { clipeId: c.video, lado: "inicio", tempo: 2 }));
    expect(executarComando(aparado.projeto, "analisarCenas", { clipeId: c.video, cenas: [1] })).toMatchObject({
      codigo: "FORA_DA_FONTE",
      detalhes: { inicio: 2, fim: 10 },
    });
    expect(sucesso(executarComando(aparado.projeto, "analisarCenas", { clipeId: c.video, cenas: [2, 10] })).alterado).toBe(true);
  });

  it("sobrevive a um corte, apontando para o mesmo trecho de áudio", () => {
    const c = cena();
    const analisado = sucesso(executarComando(c.projeto, "analisarPausas", { clipeId: c.video, pausas: [{ inicio: 1, fim: 1.5 }, { inicio: 4, fim: 4.5 }] }));
    const { projeto } = sucesso(executarComando(analisado.projeto, "cortarTrechos", { clipeId: c.video, trechos: [{ inicio: 2, fim: 3 }] }));
    const pedacos = findSegment(projeto, c.video)!.track.segments.filter((segment) => segment.materialId === "filme");
    expect(pedacos).toHaveLength(2);
    const direita = pedacos[1]!;
    expect(direita.analise!.pausas).toEqual([{ inicio: S, fim: 1.5 * S }, { inicio: 4 * S, fim: 4.5 * S }]);
    const naTimeline = direita.target.start + (direita.analise!.pausas![1]!.inicio - direita.source.start) / direita.speed;
    expect(naTimeline).toBe(3 * S);
  });

  it("depois do corte, cortarPausas em um pedaço usa só as pausas dele", () => {
    const c = cena();
    const analisado = sucesso(executarComando(c.projeto, "analisarPausas", { clipeId: c.video, pausas: [{ inicio: 1, fim: 1.6 }, { inicio: 4, fim: 4.6 }] }));
    const cortado = sucesso(executarComando(analisado.projeto, "cortarTrechos", { clipeId: c.video, trechos: [{ inicio: 2, fim: 3 }] }));
    const direita = findSegment(cortado.projeto, c.video)!.track.segments.filter((segment) => segment.materialId === "filme")[1]!;
    const { projeto } = sucesso(executarComando(cortado.projeto, "cortarPausas", { clipeId: direita.id }));
    const pedacos = findSegment(projeto, c.video)!.track.segments.filter((segment) => segment.materialId === "filme");
    expect(pedacos.map(({ source }) => source.start)).toEqual([0, 3 * S, 4.52 * S]);
  });

  it("sobrevive a mudança de velocidade", () => {
    const c = cena();
    const um = sucesso(executarComando(c.projeto, "analisarCenas", { clipeId: c.video, cenas: [4] }));
    const { projeto } = sucesso(executarComando(um.projeto, "definirVelocidade", { clipeId: c.video, velocidade: 2 }));
    expect(clipe(projeto, c.video).analise!.cenas).toEqual([4 * S]);
  });

  it("inspecionar mostra a análise em segundos, em tempo da fonte", () => {
    const c = cena();
    const video = inspecionar(comPausas(c)).faixas.flatMap(({ clipes }) => clipes).find(({ id }) => id === c.video)!;
    expect(video.analise!.pausas).toEqual([{ inicio: 1, fim: 2 }, { inicio: 4, fim: 4.3 }]);
  });

  it("projeto antigo, sem analise, carrega e os comandos funcionam", async () => {
    const c = cena();
    const antigo = JSON.parse(JSON.stringify(c.projeto)) as Project;
    expect(JSON.stringify(antigo)).not.toContain("analise");
    const { project } = await unpackProject(packProject(antigo, []));
    expect(clipe(project, c.video).analise).toBeUndefined();
    expect(validar(project)).toEqual([]);
    expect(sucesso(executarComando(project, "dividir", { clipeId: c.video, tempo: 5 })).alterado).toBe(true);
    expect(sucesso(executarComando(project, "analisarCenas", { clipeId: c.video, cenas: [1] })).alterado).toBe(true);
  });
});

describe("consultas", () => {
  it("inspecionar descreve a estrutura em segundos, sem as mídias", () => {
    const c = cena();
    const dados = inspecionar(animada(c));
    expect(dados).toMatchObject({ fps: 30, canvas: { largura: 1920, altura: 1080 }, duracao: 25 });
    const video = dados.faixas.flatMap(({ clipes }) => clipes).find(({ id }) => id === c.video)!;
    expect(video).toMatchObject({ tipo: "video", inicio: 0, duracao: 10, materialId: "filme", velocidade: 1, palavras: 3 });
    expect(video.animadas).toEqual({ brightness: [0, 2] });
    expect(dados.materiais.find(({ id }) => id === "filme")).toMatchObject({ tipo: "video", duracao: 10, temAudio: true });
  });

  it("inspecionar dá os tempos de keyframe na timeline, não no clipe", () => {
    const c = cena();
    const um = sucesso(executarComando(c.projeto, "definirKeyframe", { clipeId: c.foto, propriedade: "x", tempo: 21 }));
    const foto = inspecionar(um.projeto).faixas.flatMap(({ clipes }) => clipes).find(({ id }) => id === c.foto)!;
    expect(foto.animadas).toEqual({ x: [21] });
  });

  it("são determinísticas e não mudam o projeto", () => {
    const { projeto } = cena();
    const antes = structuredClone(projeto);
    expect(JSON.stringify(inspecionar(projeto))).toBe(JSON.stringify(inspecionar(projeto)));
    expect(JSON.stringify(validar(projeto))).toBe(JSON.stringify(validar(projeto)));
    expect(projeto).toEqual(antes);
  });

  it("validar não acusa nada num projeto correto", () => {
    expect(validar(cena().projeto)).toEqual([]);
  });

  it("validar acha duração zero", () => {
    const c = cena();
    const projeto = updateSegment(c.projeto, c.foto, (segment) => void (segment.target.duration = 0));
    expect(validar(projeto)).toEqual([expect.objectContaining({ codigo: "DURACAO_ZERO", gravidade: "erro", clipeId: c.foto, tempo: 20 })]);
  });

  it("validar acha clipes sobrepostos", () => {
    const c = cena();
    const projeto = updateSegment(c.projeto, c.video, (segment) => void (segment.target.duration = 30 * S));
    expect(validar(projeto)).toEqual([expect.objectContaining({ codigo: "SOBREPOSICAO_NA_FAIXA", clipeId: c.video })]);
  });

  it("validar acha material offline", () => {
    const c = cena();
    const projeto = { ...c.projeto, materials: { ...c.projeto.materials, filme: { ...media("filme", "video", 10), offline: true } } };
    expect(validar(projeto)).toEqual([expect.objectContaining({ codigo: "MATERIAL_OFFLINE", clipeId: c.video })]);
  });

  it("validar acha texto vazio", () => {
    const c = cena();
    const material = c.projeto.materials[c.textoMaterial]!;
    const projeto = { ...c.projeto, materials: { ...c.projeto.materials, [c.textoMaterial]: { ...material, text: "  " } } };
    expect(validar(projeto)).toEqual([expect.objectContaining({ codigo: "TEXTO_VAZIO", gravidade: "aviso", clipeId: c.texto })]);
  });

  it("validar avisa de faixa bloqueada com clipes", () => {
    const c = cena();
    const projeto = updateTrack(c.projeto, c.faixaVideo, { locked: true });
    expect(validar(projeto)).toEqual([expect.objectContaining({ codigo: "FAIXA_BLOQUEADA_COM_CLIPES", gravidade: "aviso", faixaId: c.faixaVideo })]);
  });
});
