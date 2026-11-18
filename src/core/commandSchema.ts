import { ENTRANCE_TYPES, EXIT_TYPES, LOOP_TYPES } from "./animation";
import { CURVE_CHANNELS, HSL_COLORS } from "./curves";
import { EFFECT_TYPES } from "./look";
import { MAX_VOLUME } from "./loudness";
import { MAX_SPEED, MIN_SPEED } from "./ops";
import { MAX_SPOKEN_SCALE } from "./speech";

/**
 * Description of each editing command and hand-written checks of its arguments.
 * Times are seconds on the timeline, unless a command says they are source time.
 */
export type TipoArgumento = "id" | "texto" | "numero" | "booleano" | "opcao" | "objeto" | "lista";

export interface Argumento {
  tipo: TipoArgumento;
  obrigatorio?: boolean;
  /** Accepts null, which removes what the command sets. */
  anulavel?: boolean;
  /** Refuses a blank text. */
  naoVazio?: boolean;
  min?: number;
  max?: number;
  /** Excludes the minimum itself, for lengths that cannot be zero. */
  acimaDoMin?: boolean;
  valores?: readonly string[];
  /** Further check of an object or list; returns what is wrong with it. */
  conferir?: (valor: unknown, nome: string) => string | null;
}

export interface Comando {
  descricao: string;
  argumentos: Record<string, Argumento>;
}

export const FORMAS_DE_MASCARA = ["linear", "rectangle", "circle", "heart", "star"] as const;
export const SUAVIZACOES = ["in", "out", "inOut", "hold", "back", "elastic", "bounce"] as const;
export const BORDAS = ["left", "top", "right", "bottom"] as const;
export const FORMAS = ["rectangle", "circle", "triangle", "star", "heart", "line"] as const;

const isObjeto = (valor: unknown): valor is Record<string, unknown> =>
  typeof valor === "object" && valor !== null && !Array.isArray(valor);
const isNumero = (valor: unknown): valor is number => typeof valor === "number" && Number.isFinite(valor);
const isCor = (valor: unknown) => typeof valor === "string" && /^#[0-9a-fA-F]{6}$/.test(valor);
const entre = (valor: unknown, min: number, max: number) => isNumero(valor) && valor >= min && valor <= max;

/** The one wording of an invalid argument: which one, what came in, what is accepted. */
export function invalido(nome: string, recebido: unknown, esperado: string): string {
  const valor = recebido === undefined ? "nada" : (JSON.stringify(recebido) ?? String(recebido));
  return `${nome}: recebido ${valor.length > 80 ? `${valor.slice(0, 80)}…` : valor}, esperado ${esperado}`;
}

function conferirMascara(valor: unknown, nome: string): string | null {
  if (!isObjeto(valor)) return invalido(nome, valor, "objeto no formato de Mask");
  if (!FORMAS_DE_MASCARA.includes(valor.shape as never)) {
    return invalido(`${nome}.shape`, valor.shape, `um de: ${FORMAS_DE_MASCARA.join(", ")}`);
  }
  for (const campo of ["x", "y", "rotation"]) {
    if (!isNumero(valor[campo])) return invalido(`${nome}.${campo}`, valor[campo], "número");
  }
  for (const campo of ["width", "height"]) {
    if (!isNumero(valor[campo]) || valor[campo] <= 0) return invalido(`${nome}.${campo}`, valor[campo], "número maior que 0");
  }
  if (!isNumero(valor.feather) || valor.feather < 0) return invalido(`${nome}.feather`, valor.feather, "número maior ou igual a 0");
  return typeof valor.invert === "boolean" ? null : invalido(`${nome}.invert`, valor.invert, "verdadeiro ou falso");
}

function conferirChroma(valor: unknown, nome: string): string | null {
  if (!isObjeto(valor)) return invalido(nome, valor, "objeto no formato de Chroma");
  if (!isCor(valor.color)) return invalido(`${nome}.color`, valor.color, "cor no formato #rrggbb");
  for (const campo of ["strength", "softness", "spill"]) {
    if (!entre(valor[campo], 0, 1)) return invalido(`${nome}.${campo}`, valor[campo], "número de 0 a 1");
  }
  return null;
}

function conferirAjusteHsl(valor: unknown, nome: string): string | null {
  if (!isObjeto(valor)) return invalido(nome, valor, "objeto com hue, saturation e lightness");
  for (const campo of ["hue", "saturation", "lightness"]) {
    if (!entre(valor[campo], -100, 100)) return invalido(`${nome}.${campo}`, valor[campo], "número de -100 a 100");
  }
  return null;
}

function conferirPontos(valor: unknown, nome: string): string | null {
  if (!Array.isArray(valor) || valor.length < 2) return invalido(nome, valor, "lista com ao menos 2 pontos");
  const errado = valor.findIndex((ponto) => !(Array.isArray(ponto) && ponto.length === 2 && ponto.every((eixo) => entre(eixo, 0, 1))));
  return errado < 0 ? null : invalido(`${nome}[${errado}]`, valor[errado], "ponto [x, y], com x e y de 0 a 1");
}

function conferirTrechos(valor: unknown, nome: string): string | null {
  if (!Array.isArray(valor) || valor.length === 0) return invalido(nome, valor, "lista com ao menos 1 trecho");
  const errado = valor.findIndex(
    (trecho) => !(isObjeto(trecho) && isNumero(trecho.inicio) && isNumero(trecho.fim) && trecho.inicio >= 0 && trecho.fim > trecho.inicio),
  );
  return errado < 0 ? null : invalido(`${nome}[${errado}]`, valor[errado], "{ inicio, fim }, com inicio maior ou igual a 0 e fim depois de inicio");
}

function conferirTempos(valor: unknown, nome: string): string | null {
  if (!Array.isArray(valor)) return invalido(nome, valor, "lista de tempos em segundos");
  const errado = valor.findIndex((tempo) => !isNumero(tempo) || tempo < 0);
  if (errado >= 0) return invalido(`${nome}[${errado}]`, valor[errado], "número maior ou igual a 0");
  const fora = valor.findIndex((tempo, index) => index > 0 && tempo <= valor[index - 1]);
  return fora < 0 ? null : invalido(`${nome}[${fora}]`, valor[fora], `tempo depois de ${valor[fora - 1]}, em ordem crescente`);
}

function conferirPausas(valor: unknown, nome: string): string | null {
  if (!Array.isArray(valor)) return invalido(nome, valor, "lista de { inicio, fim }");
  const errado = valor.findIndex(
    (pausa) => !(isObjeto(pausa) && isNumero(pausa.inicio) && isNumero(pausa.fim) && pausa.inicio >= 0 && pausa.fim > pausa.inicio),
  );
  if (errado >= 0) return invalido(`${nome}[${errado}]`, valor[errado], "{ inicio, fim }, com inicio maior ou igual a 0 e fim depois de inicio");
  const ordenadas = [...(valor as { inicio: number; fim: number }[])].sort((a, b) => a.inicio - b.inicio);
  const sobreposta = ordenadas.findIndex((pausa, index) => index > 0 && pausa.inicio < ordenadas[index - 1]!.fim);
  return sobreposta < 0 ? null : invalido(nome, ordenadas[sobreposta], `pausas sem sobreposição, mas esta começa antes de ${ordenadas[sobreposta - 1]!.fim}`);
}

function conferirLoudness(valor: unknown, nome: string): string | null {
  if (!isObjeto(valor)) return invalido(nome, valor, "objeto com integrado e pico");
  if (!entre(valor.integrado, -70, 0)) return invalido(`${nome}.integrado`, valor.integrado, "número de -70 a 0, em LUFS");
  return entre(valor.pico, -120, 0) ? null : invalido(`${nome}.pico`, valor.pico, "número de -120 a 0, em dBFS");
}

function conferirPalavras(valor: unknown, nome: string): string | null {
  if (!Array.isArray(valor)) return invalido(nome, valor, "lista de { text, start, end }");
  const errado = valor.findIndex(
    (palavra) =>
      !(isObjeto(palavra) && typeof palavra.text === "string" && palavra.text.trim() && isNumero(palavra.start) && isNumero(palavra.end) && palavra.start >= 0 && palavra.end > palavra.start),
  );
  return errado < 0 ? null : invalido(`${nome}[${errado}]`, valor[errado], "{ text, start, end }, com text não vazio, start maior ou igual a 0 e end depois de start");
}

function conferirInteiro(valor: unknown, nome: string): string | null {
  return Number.isInteger(valor) ? null : invalido(nome, valor, "número inteiro");
}

/** Any colour a canvas accepts in practice: #rgb, #rrggbb, #rrggbbaa, rgb(), rgba(), hsl() or hsla(). */
const isCorCss = (valor: unknown) =>
  typeof valor === "string" && /^(#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})|(rgb|rgba|hsl|hsla)\([^)]*\))$/i.test(valor.trim());

function conferirCorCss(valor: unknown, nome: string): string | null {
  return isCorCss(valor) ? null : invalido(nome, valor, "cor, como #ffd23f ou rgba(0,0,0,0.5)");
}

/** A colour, or an empty text that turns the part off. */
const corOuVazio = (valor: unknown) => valor === "" || isCorCss(valor);

function conferirAnimacao(tipos: readonly string[]) {
  return (valor: unknown, nome: string): string | null => {
    if (!isObjeto(valor)) return invalido(nome, valor, "objeto { tipo, duracao }");
    if (!tipos.includes(valor.tipo as string)) return invalido(`${nome}.tipo`, valor.tipo, `um de: ${tipos.join(", ")}`);
    if (!isNumero(valor.duracao) || valor.duracao <= 0) return invalido(`${nome}.duracao`, valor.duracao, "número maior que 0, em segundos");
    const sobra = Object.keys(valor).find((chave) => chave !== "tipo" && chave !== "duracao");
    return sobra ? invalido(`${nome}.${sobra}`, valor[sobra], "nada; só tipo e duracao") : null;
  };
}

function conferirMoldura(valor: unknown, nome: string): string | null {
  if (!isObjeto(valor)) return invalido(nome, valor, "objeto no formato de ClipFrame");
  for (const campo of ["radius", "strokeWidth", "shadowSize"]) {
    if (!entre(valor[campo], 0, 1)) return invalido(`${nome}.${campo}`, valor[campo], "número de 0 a 1");
  }
  for (const campo of ["strokeColor", "shadowColor"]) {
    if (!corOuVazio(valor[campo])) return invalido(`${nome}.${campo}`, valor[campo], "cor, ou texto vazio para não ter");
  }
  return null;
}

function conferirEfeitosDeAudio(valor: unknown, nome: string): string | null {
  if (!isObjeto(valor)) return invalido(nome, valor, "objeto no formato de AudioEffects");
  for (const campo of ["low", "mid", "high"]) {
    if (!entre(valor[campo], -12, 12)) return invalido(`${nome}.${campo}`, valor[campo], "número de -12 a 12, em dB");
  }
  if (typeof valor.compressor !== "boolean") return invalido(`${nome}.compressor`, valor.compressor, "verdadeiro ou falso");
  return entre(valor.reverb, 0, 1) ? null : invalido(`${nome}.reverb`, valor.reverb, "número de 0 a 1");
}

function conferirPalavrasDitas(valor: unknown, nome: string): string | null {
  if (!Array.isArray(valor) || valor.length === 0) return invalido(nome, valor, "lista com ao menos 1 { texto, inicio, fim }");
  const errado = valor.findIndex(
    (palavra) =>
      !(
        isObjeto(palavra) &&
        typeof palavra.texto === "string" &&
        palavra.texto.trim() &&
        isNumero(palavra.inicio) &&
        isNumero(palavra.fim) &&
        palavra.inicio >= 0 &&
        palavra.fim > palavra.inicio &&
        (palavra.quebra === undefined || typeof palavra.quebra === "boolean")
      ),
  );
  return errado < 0
    ? null
    : invalido(`${nome}[${errado}]`, valor[errado], "{ texto, inicio, fim, quebra? }, com texto não vazio, inicio maior ou igual a 0 e fim depois de inicio, em segundos");
}

function conferirDestaque(valor: unknown, nome: string): string | null {
  if (!isObjeto(valor)) return invalido(nome, valor, "objeto { cor, escala?, caixa?, modo? }");
  if (!isCorCss(valor.cor)) return invalido(`${nome}.cor`, valor.cor, "cor da palavra falada");
  if (valor.escala !== undefined && !entre(valor.escala, 1, MAX_SPOKEN_SCALE)) {
    return invalido(`${nome}.escala`, valor.escala, `número de 1 a ${MAX_SPOKEN_SCALE}`);
  }
  if (valor.caixa !== undefined && !corOuVazio(valor.caixa)) return invalido(`${nome}.caixa`, valor.caixa, "cor, ou texto vazio para não ter");
  if (valor.modo !== undefined && valor.modo !== "highlight" && valor.modo !== "single") {
    return invalido(`${nome}.modo`, valor.modo, "highlight ou single");
  }
  return null;
}

type Regra = (valor: unknown) => boolean;
const booleano: Regra = (valor) => typeof valor === "boolean";
const numeroEntre = (min: number, max: number): Regra => (valor) => entre(valor, min, max);

/** Every field estilizar may change, with what it accepts, by kind of material. */
const ESTILOS: Record<"text" | "shape", Record<string, [Regra, string]>> = {
  text: {
    fontFamily: [(valor) => typeof valor === "string" && valor.trim() !== "", "nome de fonte"],
    fontSize: [numeroEntre(1, 1000), "número de 1 a 1000"],
    color: [isCorCss, "cor"],
    bold: [booleano, "verdadeiro ou falso"],
    italic: [booleano, "verdadeiro ou falso"],
    align: [(valor) => ["left", "center", "right"].includes(valor as string), "left, center ou right"],
    strokeColor: [isCorCss, "cor"],
    strokeWidth: [numeroEntre(0, 100), "número de 0 a 100"],
    background: [corOuVazio, "cor, ou texto vazio para não ter fundo"],
    backgroundPadding: [numeroEntre(0, 3), "número de 0 a 3, em tamanhos de fonte"],
    backgroundRadius: [numeroEntre(0, 1), "número de 0 a 1"],
    letterSpacing: [numeroEntre(-50, 200), "número de -50 a 200"],
    lineHeight: [numeroEntre(0.5, 4), "número de 0,5 a 4"],
    curve: [numeroEntre(-360, 360), "número de -360 a 360"],
    shadow: [
      (valor) => valor === null || (isObjeto(valor) && isCorCss(valor.color) && isNumero(valor.blur) && isNumero(valor.distance) && isNumero(valor.angle)),
      "{ color, blur, distance, angle } ou null",
    ],
    spoken: [
      (valor) =>
        valor === null ||
        (isObjeto(valor) &&
          (valor.mode === "highlight" || valor.mode === "single") &&
          isCorCss(valor.color) &&
          (valor.scale === undefined || entre(valor.scale, 1, MAX_SPOKEN_SCALE)) &&
          (valor.box === undefined || corOuVazio(valor.box))),
      `{ mode, color, scale? de 1 a ${MAX_SPOKEN_SCALE}, box? } ou null`,
    ],
  },
  shape: {
    shape: [(valor) => FORMAS.includes(valor as never), `um de: ${FORMAS.join(", ")}`],
    fill: [corOuVazio, "cor, ou texto vazio para vazar"],
    fill2: [corOuVazio, "cor, ou texto vazio para cor única"],
    gradientAngle: [isNumero, "número, em graus"],
    stroke: [corOuVazio, "cor, ou texto vazio"],
    strokeWidth: [numeroEntre(0, 200), "número de 0 a 200"],
    radius: [numeroEntre(0, 0.5), "número de 0 a 0,5"],
    width: [numeroEntre(0.001, 10), "número maior que 0, em frações do lado menor da tela"],
    height: [numeroEntre(0.001, 10), "número maior que 0, em frações do lado menor da tela"],
  },
};

/** What is wrong with a style for a text or a shape, or null. */
export function conferirEstilo(tipo: "text" | "shape", valor: unknown, nome: string): string | null {
  if (!isObjeto(valor)) return invalido(nome, valor, "objeto com campos de estilo");
  const regras = ESTILOS[tipo];
  for (const [campo, item] of Object.entries(valor)) {
    const regra = regras[campo];
    if (!regra) return invalido(`${nome}.${campo}`, item, `nenhum valor, porque o estilo de ${tipo === "text" ? "texto" : "forma"} só aceita: ${Object.keys(regras).join(", ")}`);
    if (!regra[0](item)) return invalido(`${nome}.${campo}`, item, regra[1]);
  }
  return null;
}

const clipeId: Argumento = { tipo: "id", obrigatorio: true };
const tempo: Argumento = { tipo: "numero", obrigatorio: true, min: 0 };
const tempoOpcional: Argumento = { tipo: "numero", min: 0 };
const duracao: Argumento = { tipo: "numero", min: 0, acimaDoMin: true };

export const ESQUEMA: Record<string, Comando> = {
  adicionarClipe: {
    descricao: "Coloca um material na timeline; duracao e inicioFonte (tempo da fonte) escolhem o trecho.",
    argumentos: {
      materialId: { tipo: "id", obrigatorio: true },
      inicio: tempo,
      faixaId: { tipo: "id" },
      duracao,
      inicioFonte: tempoOpcional,
    },
  },
  definirProjeto: {
    descricao: "Muda nome, tamanho da tela, quadros por segundo ou cor de fundo (null volta ao preto).",
    argumentos: {
      nome: { tipo: "texto", naoVazio: true },
      largura: { tipo: "numero", min: 16, max: 8192, conferir: conferirInteiro },
      altura: { tipo: "numero", min: 16, max: 8192, conferir: conferirInteiro },
      fps: { tipo: "numero", min: 1, max: 120 },
      fundo: { tipo: "texto", anulavel: true, conferir: conferirCorCss },
    },
  },
  criarFaixa: {
    descricao: "Cria uma faixa vazia; posicao 0 desenha por baixo das outras do mesmo tipo.",
    argumentos: {
      tipo: { tipo: "opcao", obrigatorio: true, valores: ["video", "text", "audio"] },
      nome: { tipo: "texto", naoVazio: true },
      posicao: { tipo: "numero", min: 0, conferir: conferirInteiro },
    },
  },
  adicionarForma: {
    descricao: "Adiciona uma forma na timeline, numa faixa de texto.",
    argumentos: {
      forma: { tipo: "opcao", obrigatorio: true, valores: FORMAS },
      inicio: tempo,
      duracao: { ...duracao, obrigatorio: true },
      faixaId: { tipo: "id" },
    },
  },
  estilizar: {
    descricao: "Muda a aparência de um texto ou forma, com os campos de TextMaterial ou ShapeMaterial; null remove sombra ou destaque.",
    argumentos: {
      clipeId: { tipo: "id" },
      materialId: { tipo: "id" },
      estilo: { tipo: "objeto", obrigatorio: true },
    },
  },
  definirAnimacao: {
    descricao: "Define ou remove (null) as animações de entrada, saída e loop: { tipo, duracao }.",
    argumentos: {
      clipeId,
      entrada: { tipo: "objeto", anulavel: true, conferir: conferirAnimacao(ENTRANCE_TYPES) },
      saida: { tipo: "objeto", anulavel: true, conferir: conferirAnimacao(EXIT_TYPES) },
      loop: { tipo: "objeto", anulavel: true, conferir: conferirAnimacao(LOOP_TYPES) },
    },
  },
  definirMoldura: {
    descricao: "Define ou remove (null) a moldura de um vídeo ou imagem, no formato de ClipFrame.",
    argumentos: { clipeId, moldura: { tipo: "objeto", obrigatorio: true, anulavel: true, conferir: conferirMoldura } },
  },
  definirEnquadramento: {
    descricao: "contain mostra o vídeo ou imagem inteiro; cover preenche a tela e corta o que sobra.",
    argumentos: { clipeId, enquadramento: { tipo: "opcao", obrigatorio: true, valores: ["contain", "cover"] } },
  },
  definirFades: {
    descricao: "Define o fade de entrada e de saída do som de um vídeo ou áudio, em segundos.",
    argumentos: { clipeId, entrada: tempoOpcional, saida: tempoOpcional },
  },
  definirEfeitosDeAudio: {
    descricao: "Define ou remove (null) equalizador, compressor e reverb, no formato de AudioEffects.",
    argumentos: { clipeId, efeitos: { tipo: "objeto", obrigatorio: true, anulavel: true, conferir: conferirEfeitosDeAudio } },
  },
  definirTransformacao: {
    descricao: "Define de uma vez posição, escala, rotação e opacidade de um clipe sem keyframes nelas.",
    argumentos: {
      clipeId,
      x: { tipo: "numero" },
      y: { tipo: "numero" },
      escala: { tipo: "numero", min: 0, acimaDoMin: true },
      rotacao: { tipo: "numero" },
      opacidade: { tipo: "numero", min: 0, max: 1 },
    },
  },
  adicionarLegendas: {
    descricao: "Cria legendas palavra por palavra a partir de palavras com tempo na timeline, numa faixa nova ou na faixaId.",
    argumentos: {
      palavras: { tipo: "lista", obrigatorio: true, conferir: conferirPalavrasDitas },
      faixaId: { tipo: "id" },
      nome: { tipo: "texto", naoVazio: true },
      maxPalavras: { tipo: "numero", min: 1, max: 12, conferir: conferirInteiro },
      maxLetras: { tipo: "numero", min: 1, max: 80, conferir: conferirInteiro },
      maiusculas: { tipo: "booleano" },
      sobra: { tipo: "numero", min: 0, max: 5 },
      y: { tipo: "numero" },
      estilo: { tipo: "objeto", conferir: (valor, nome) => conferirEstilo("text", valor, nome) },
      destaque: { tipo: "objeto", conferir: conferirDestaque },
      entrada: { tipo: "objeto", conferir: conferirAnimacao(ENTRANCE_TYPES) },
    },
  },
  moverClipe: {
    descricao: "Move um clipe e o resto do seu grupo; com apenasClipe, só ele.",
    argumentos: { clipeId, inicio: tempo, faixaId: { tipo: "id" }, apenasClipe: { tipo: "booleano" } },
  },
  aparar: {
    descricao: "Move a borda inicial ou final de um clipe.",
    argumentos: { clipeId, lado: { tipo: "opcao", obrigatorio: true, valores: ["inicio", "fim"] }, tempo },
  },
  dividir: { descricao: "Divide um clipe no quadro mais próximo do tempo.", argumentos: { clipeId, tempo } },
  excluir: {
    descricao: "Exclui um clipe; com fecharEspaco, puxa o que vem depois.",
    argumentos: { clipeId, fecharEspaco: { tipo: "booleano" } },
  },
  duplicar: { descricao: "Copia um clipe para logo depois dele.", argumentos: { clipeId } },
  definirVelocidade: {
    descricao: "Muda a velocidade de um vídeo ou áudio.",
    argumentos: { clipeId, velocidade: { tipo: "numero", obrigatorio: true, min: MIN_SPEED, max: MAX_SPEED } },
  },
  congelarQuadro: {
    descricao: "Segura o quadro de um vídeo em um tempo.",
    argumentos: { clipeId, tempo, duracao },
  },
  definirPropriedade: {
    descricao: "Define uma propriedade; se ela é animada, grava um keyframe no tempo.",
    argumentos: {
      clipeId,
      propriedade: { tipo: "texto", obrigatorio: true },
      valor: { tipo: "numero", obrigatorio: true },
      tempo: tempoOpcional,
    },
  },
  definirKeyframe: {
    descricao: "Cria ou atualiza um keyframe no tempo; sem valor, usa o valor atual da propriedade.",
    argumentos: {
      clipeId,
      propriedade: { tipo: "texto", obrigatorio: true },
      tempo,
      valor: { tipo: "numero" },
    },
  },
  removerKeyframe: {
    descricao: "Remove o keyframe de uma propriedade no tempo.",
    argumentos: { clipeId, propriedade: { tipo: "texto", obrigatorio: true }, tempo },
  },
  definirSuavizacao: {
    descricao: "Define a curva dos keyframes, ou só do keyframe no tempo; null deixa reta.",
    argumentos: {
      clipeId,
      suavizacao: { tipo: "opcao", obrigatorio: true, anulavel: true, valores: SUAVIZACOES },
      tempo: tempoOpcional,
    },
  },
  definirRecorte: {
    descricao: "Recorta uma borda de um vídeo ou imagem.",
    argumentos: {
      clipeId,
      borda: { tipo: "opcao", obrigatorio: true, valores: BORDAS },
      valor: { tipo: "numero", obrigatorio: true, min: 0, max: 1 },
    },
  },
  adicionarTexto: {
    descricao: "Adiciona um texto na timeline.",
    argumentos: {
      texto: { tipo: "texto", obrigatorio: true, naoVazio: true },
      inicio: tempo,
      duracao: { ...duracao, obrigatorio: true },
      faixaId: { tipo: "id" },
    },
  },
  definirTexto: {
    descricao: "Troca o conteúdo de um texto, indicado por materialId ou clipeId.",
    argumentos: {
      materialId: { tipo: "id" },
      clipeId: { tipo: "id" },
      texto: { tipo: "texto", obrigatorio: true, naoVazio: true },
    },
  },
  substituirTexto: {
    descricao: "Troca uma palavra ou frase em todos os textos.",
    argumentos: { de: { tipo: "texto", obrigatorio: true, naoVazio: true }, para: { tipo: "texto", obrigatorio: true } },
  },
  definirVolume: {
    descricao: "Define o volume de um vídeo ou áudio; 1 mantém o original.",
    argumentos: { clipeId, volume: { tipo: "numero", obrigatorio: true, min: 0, max: MAX_VOLUME } },
  },
  cortarTrechos: {
    descricao: "Corta trechos da timeline, indicados em tempo da fonte do clipe.",
    argumentos: { clipeId, trechos: { tipo: "lista", obrigatorio: true, conferir: conferirTrechos } },
  },
  marcar: {
    descricao: "Cria um marcador no tempo, se ainda não houver um nesse quadro.",
    argumentos: { tempo, rotulo: { tipo: "texto", naoVazio: true } },
  },
  removerMarcador: {
    descricao: "Remove um marcador pelo id que aparece em inspecionar.",
    argumentos: { marcadorId: { tipo: "id", obrigatorio: true } },
  },
  definirMascara: {
    descricao: "Define ou remove (null) a máscara de um clipe, no formato de Mask.",
    argumentos: { clipeId, mascara: { tipo: "objeto", obrigatorio: true, anulavel: true, conferir: conferirMascara } },
  },
  definirChroma: {
    descricao: "Define ou remove (null) o chroma key, no formato de Chroma.",
    argumentos: { clipeId, chroma: { tipo: "objeto", obrigatorio: true, anulavel: true, conferir: conferirChroma } },
  },
  definirEfeito: {
    descricao: "Define a intensidade de um efeito; null remove o efeito e seus keyframes.",
    argumentos: {
      clipeId,
      efeito: { tipo: "opcao", obrigatorio: true, valores: EFFECT_TYPES },
      valor: { tipo: "numero", obrigatorio: true, anulavel: true, min: 0, max: 1 },
    },
  },
  definirHsl: {
    descricao: "Ajusta ou limpa (null) uma cor do HSL, com hue, saturation e lightness.",
    argumentos: {
      clipeId,
      cor: { tipo: "opcao", obrigatorio: true, valores: HSL_COLORS },
      ajuste: { tipo: "objeto", obrigatorio: true, anulavel: true, conferir: conferirAjusteHsl },
    },
  },
  definirCurvas: {
    descricao: "Define ou limpa (null) a curva de um canal, com pontos [x, y] de 0 a 1.",
    argumentos: {
      clipeId,
      canal: { tipo: "opcao", obrigatorio: true, valores: CURVE_CHANNELS },
      pontos: { tipo: "lista", obrigatorio: true, anulavel: true, conferir: conferirPontos },
    },
  },
  definirLut: {
    descricao: "Aplica ou remove (null) uma LUT já importada no projeto.",
    argumentos: {
      clipeId,
      lutId: { tipo: "id", obrigatorio: true, anulavel: true },
      forca: { tipo: "numero", min: 0, max: 1 },
    },
  },
  analisarCenas: {
    descricao: "Grava as trocas de cena medidas, em tempo da fonte.",
    argumentos: { clipeId, cenas: { tipo: "lista", obrigatorio: true, conferir: conferirTempos } },
  },
  analisarPausas: {
    descricao: "Grava os silêncios medidos, inteiros, em tempo da fonte.",
    argumentos: { clipeId, pausas: { tipo: "lista", obrigatorio: true, conferir: conferirPausas } },
  },
  analisarBatidas: {
    descricao: "Grava as batidas medidas, em tempo da fonte, em analise.batidas e em beats.",
    argumentos: { clipeId, batidas: { tipo: "lista", obrigatorio: true, conferir: conferirTempos } },
  },
  analisarLoudness: {
    descricao: "Grava o loudness medido: integrado em LUFS e pico em dBFS.",
    argumentos: { clipeId, loudness: { tipo: "objeto", obrigatorio: true, conferir: conferirLoudness } },
  },
  transcrever: {
    descricao: "Grava as palavras faladas em words, em tempo da fonte.",
    argumentos: { clipeId, palavras: { tipo: "lista", obrigatorio: true, conferir: conferirPalavras } },
  },
  cortarPausas: {
    descricao: "Corta os silêncios de analise.pausas a partir do mínimo, com margem em volta das palavras.",
    argumentos: { clipeId, minimo: duracao },
  },
  cortarHesitacoes: {
    descricao: "Corta hesitações, como \"hum\", das palavras já transcritas da faixa do clipe.",
    argumentos: { clipeId },
  },
  criarLegendas: {
    descricao: "Cria legendas a partir das palavras já transcritas da faixa do clipe.",
    argumentos: { clipeId },
  },
};

/** What an argument accepts, in words. */
function esperado(regra: Argumento): string {
  const nulo = regra.anulavel ? " ou null" : "";
  switch (regra.tipo) {
    case "id":
      return `um id${nulo}`;
    case "texto":
      return regra.naoVazio ? "texto não vazio" : "texto";
    case "booleano":
      return "verdadeiro ou falso";
    case "opcao":
      return `um de: ${regra.valores!.join(", ")}${nulo}`;
    case "objeto":
      return `objeto${nulo}`;
    case "lista":
      return `lista${nulo}`;
    case "numero": {
      const limites = [
        regra.min === undefined ? "" : `maior ${regra.acimaDoMin ? "que" : "ou igual a"} ${regra.min}`,
        regra.max === undefined ? "" : `menor ou igual a ${regra.max}`,
      ].filter(Boolean);
      return `número${limites.length ? ` ${limites.join(" e ")}` : ""}${nulo}`;
    }
  }
}

function aceita(regra: Argumento, valor: unknown): boolean {
  switch (regra.tipo) {
    case "id":
      return typeof valor === "string" && valor !== "";
    case "texto":
      return typeof valor === "string" && (!regra.naoVazio || valor.trim() !== "");
    case "booleano":
      return typeof valor === "boolean";
    case "opcao":
      return regra.valores!.includes(valor as string);
    case "numero":
      return (
        isNumero(valor) &&
        (regra.min === undefined || valor > regra.min || (valor === regra.min && !regra.acimaDoMin)) &&
        (regra.max === undefined || valor <= regra.max)
      );
    default:
      return true;
  }
}

function erroDoValor(nome: string, regra: Argumento, valor: unknown): string | null {
  if (valor === null) return regra.anulavel ? null : invalido(nome, valor, esperado(regra));
  if (!aceita(regra, valor)) return invalido(nome, valor, esperado(regra));
  return regra.conferir?.(valor, nome) ?? null;
}

/** What is wrong with the arguments of a known command, or null when they are fine. */
export function conferirArgumentos(comando: string, args: unknown): string | null {
  if (!isObjeto(args)) return invalido("args", args, "objeto com os argumentos do comando");
  const { argumentos } = ESQUEMA[comando]!;
  for (const nome of Object.keys(args)) {
    if (!(nome in argumentos)) {
      return invalido(nome, args[nome], `nenhum valor, porque o comando só aceita: ${Object.keys(argumentos).join(", ")}`);
    }
  }
  for (const [nome, regra] of Object.entries(argumentos)) {
    if (args[nome] === undefined) {
      if (regra.obrigatorio) return invalido(nome, undefined, esperado(regra));
      continue;
    }
    const problema = erroDoValor(nome, regra, args[nome]);
    if (problema) return problema;
  }
  return null;
}
