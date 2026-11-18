import { describe, expect, it } from "vitest";
import { agruparLegendas, conferirPlano, executarComando, executarPlano, type Resultado } from "../src/core/commands";
import { createProject, findSegment, type MediaMaterial, type Project, type TextMaterial } from "../src/core/model";

const S = 1_000_000;

function media(id: string, kind: MediaMaterial["kind"], seconds: number, name = `${id}.mp4`): MediaMaterial {
  return { id, kind, name, duration: seconds * S, width: 1920, height: 1080, hasAudio: kind !== "image" };
}

function base(): Project {
  return {
    ...createProject("Teste"),
    materials: {
      filme: media("filme", "video", 10, "piano.mp4"),
      capa: media("capa", "image", 0, "livro.png"),
      voz: media("voz", "audio", 8, "narracao.wav"),
    },
  };
}

const ok = (resultado: Resultado) => {
  if (!resultado.ok) throw new Error(`${resultado.codigo}: ${resultado.mensagem}`);
  return resultado;
};

describe("adicionarClipe com trecho da fonte", () => {
  it("usa inicioFonte e duracao", () => {
    const r = ok(executarComando(base(), "adicionarClipe", { materialId: "filme", inicio: 2, inicioFonte: 3, duracao: 2.5 }));
    const { segment } = findSegment(r.projeto, r.afetados.find((id) => findSegment(r.projeto, id))!)!;
    expect(segment.source).toEqual({ start: 3 * S, duration: 2.5 * S });
    expect(segment.target).toEqual({ start: 2 * S, duration: 2.5 * S });
    expect(r.avisos).toEqual([]);
  });

  it("limita a duração ao que resta da fonte e avisa", () => {
    const r = ok(executarComando(base(), "adicionarClipe", { materialId: "filme", inicio: 0, inicioFonte: 8, duracao: 5 }));
    const { segment } = findSegment(r.projeto, r.afetados.find((id) => findSegment(r.projeto, id))!)!;
    expect(segment.target.duration).toBe(2 * S);
    expect(r.avisos[0]).toMatch(/Duração limitada/);
  });

  it("estica imagem pelo tempo pedido e ignora inicioFonte com aviso", () => {
    const r = ok(executarComando(base(), "adicionarClipe", { materialId: "capa", inicio: 1, inicioFonte: 2, duracao: 3 }));
    const { segment } = findSegment(r.projeto, r.afetados.find((id) => findSegment(r.projeto, id))!)!;
    expect(segment.target).toEqual({ start: 1 * S, duration: 3 * S });
    expect(r.avisos[0]).toMatch(/inicioFonte foi ignorado/);
  });
});

describe("definirProjeto e criarFaixa", () => {
  it("muda a tela e não acusa mudança quando nada muda", () => {
    const r = ok(executarComando(base(), "definirProjeto", { largura: 1080, altura: 1920, fps: 30 }));
    expect(r.projeto.canvas).toEqual({ width: 1080, height: 1920 });
    const igual = ok(executarComando(r.projeto, "definirProjeto", { largura: 1080 }));
    expect(igual.alterado).toBe(false);
    expect(igual.projeto).toBe(r.projeto);
  });

  it("fundo null volta ao preto", () => {
    const com = ok(executarComando(base(), "definirProjeto", { fundo: "#123456" })).projeto;
    expect(com.background).toEqual({ kind: "color", color: "#123456" });
    expect(ok(executarComando(com, "definirProjeto", { fundo: null })).projeto.background).toBeUndefined();
  });

  it("posicao 0 põe a faixa por baixo das outras", () => {
    const um = ok(executarComando(base(), "criarFaixa", { tipo: "video", nome: "Cenas" })).projeto;
    const dois = ok(executarComando(um, "criarFaixa", { tipo: "video", nome: "Fundo", posicao: 0 })).projeto;
    expect(dois.tracks.map((track) => track.name)).toEqual(["Fundo", "Cenas"]);
  });
});

describe("estilizar", () => {
  it("muda campos e remove a sombra com null", () => {
    const comTexto = ok(executarComando(base(), "adicionarTexto", { texto: "Oi", inicio: 0, duracao: 1 }));
    const clipeId = comTexto.afetados.find((id) => findSegment(comTexto.projeto, id))!;
    const sombra = { color: "#000000", blur: 10, distance: 2, angle: 90 };
    const um = ok(executarComando(comTexto.projeto, "estilizar", { clipeId, estilo: { fontSize: 120, shadow: sombra, backgroundPadding: 0.6 } }));
    const material = () => (p: Project) => p.materials[findSegment(p, clipeId)!.segment.materialId] as TextMaterial;
    expect(material()(um.projeto)).toMatchObject({ fontSize: 120, shadow: sombra, backgroundPadding: 0.6 });
    const dois = ok(executarComando(um.projeto, "estilizar", { clipeId, estilo: { shadow: null } }));
    expect("shadow" in material()(dois.projeto)).toBe(false);
  });
});

describe("legendas palavra por palavra", () => {
  const palavras = [
    { texto: "quem", inicio: 0, fim: 0.3 },
    { texto: "toca", inicio: 0.3, fim: 0.6 },
    { texto: "piano", inicio: 0.6, fim: 1 },
    { texto: "de", inicio: 1, fim: 1.1 },
    { texto: "ouvido.", inicio: 1.1, fim: 1.5 },
    { texto: "depois", inicio: 3, fim: 3.4 },
  ];

  it("agrupa por quantidade, pontuação e pausa", () => {
    const grupos = agruparLegendas(palavras, 3, 18).map((grupo) => grupo.map((p) => p.texto).join(" "));
    expect(grupos).toEqual(["quem toca piano", "de ouvido.", "depois"]);
  });

  it("quebra onde a palavra pede, mesmo sem pontuação", () => {
    const marcadas = palavras.map((p) => (p.texto === "toca" ? { ...p, quebra: true } : p));
    const grupos = agruparLegendas(marcadas, 3, 18).map((grupo) => grupo.map((p) => p.texto).join(" "));
    expect(grupos[0]).toBe("quem toca");
  });

  it("cria uma faixa com destaque, tempo relativo e maiúsculas", () => {
    const r = ok(
      executarComando(base(), "adicionarLegendas", {
        palavras,
        maiusculas: true,
        y: -0.35,
        destaque: { cor: "#ffd23f", escala: 1.2, caixa: "#7c3aed" },
        estilo: { fontFamily: "Anton", fontSize: 100 },
        entrada: { tipo: "pop", duracao: 0.15 },
      }),
    );
    const track = r.projeto.tracks.find((item) => item.name === "Legendas")!;
    expect(track.segments).toHaveLength(3);
    const [primeira, segunda] = track.segments;
    const material = r.projeto.materials[segunda!.materialId] as TextMaterial;
    expect(material.text).toBe("DE OUVIDO.");
    expect(material.fontFamily).toBe("Anton");
    expect(material.spoken).toEqual({ mode: "highlight", color: "#ffd23f", scale: 1.2, box: "#7c3aed" });
    expect(material.timing).toEqual([
      { text: "DE", start: 0, end: 0.1 * S },
      { text: "OUVIDO.", start: 0.1 * S, end: 0.5 * S },
    ]);
    // Ends where the next caption begins, never overlapping it.
    expect(primeira!.target.start + primeira!.target.duration).toBeLessThanOrEqual(segunda!.target.start);
    expect(segunda!.transform.y).toBe(-0.35);
    expect(segunda!.animIn).toEqual({ type: "pop", duration: 0.15 * S });
  });
});

describe("executarPlano", () => {
  it("liga passos por nome e encontra mídia pelo nome do arquivo", () => {
    const r = executarPlano(base(), [
      { comando: "definirProjeto", args: { largura: 1080, altura: 1920 } },
      { comando: "criarFaixa", args: { tipo: "video", nome: "Cenas" }, como: "cenas" },
      { comando: "adicionarClipe", args: { materialId: "@piano.mp4", inicio: 0, duracao: 2, faixaId: "$cenas" }, como: "c1" },
      { comando: "definirEnquadramento", args: { clipeId: "$c1", enquadramento: "cover" } },
      { comando: "adicionarClipe", args: { materialId: "@livro.png", inicio: 0.5, duracao: 1 }, como: "livro" },
      { comando: "definirTransformacao", args: { clipeId: "$livro", escala: 0.6, y: 0.3 } },
    ]);
    expect(r.ok).toBe(true);
    expect(r.relatorio.every((passo) => passo.ok)).toBe(true);
    const cenas = r.projeto.tracks.find((track) => track.id === r.nomes.cenas)!;
    expect(cenas.segments.map((segment) => segment.id)).toEqual([r.nomes.c1]);
    expect(findSegment(r.projeto, r.nomes.c1!)!.segment.fit).toBe("cover");
    expect(findSegment(r.projeto, r.nomes.livro!)!.segment.transform).toMatchObject({ scale: 0.6, y: 0.3 });
  });

  it("para no primeiro erro e não aplica nada", () => {
    const projeto = base();
    const r = executarPlano(projeto, [
      { comando: "adicionarTexto", args: { texto: "A", inicio: 0, duracao: 1 } },
      { comando: "adicionarClipe", args: { materialId: "@nada.mp4", inicio: 0 } },
      { comando: "adicionarTexto", args: { texto: "B", inicio: 2, duracao: 1 } },
    ]);
    expect(r.ok).toBe(false);
    expect(r.projeto).toBe(projeto);
    expect(r.relatorio).toHaveLength(2);
    expect(r.relatorio[1]).toMatchObject({ ok: false, codigo: "MATERIAL_NAO_ENCONTRADO" });
  });

  it("sem falharAoPrimeiroErro, pula o passo ruim e segue", () => {
    const r = executarPlano(
      base(),
      [
        { comando: "adicionarTexto", args: { texto: "A", inicio: 0, duracao: 1 } },
        { comando: "adicionarClipe", args: { materialId: "@nada.mp4", inicio: 0 } },
        { comando: "adicionarTexto", args: { texto: "B", inicio: 2, duracao: 1 } },
      ],
      { falharAoPrimeiroErro: false },
    );
    expect(r.ok).toBe(false);
    expect(r.alterado).toBe(true);
    expect(r.relatorio.map((passo) => passo.ok)).toEqual([true, false, true]);
  });

  it("confere o plano inteiro antes de executar", () => {
    expect(conferirPlano([{ comando: "voar" }])).toMatchObject({ indice: 0 });
    expect(conferirPlano([{ comando: "excluir", args: { clipeId: "$ninguem" } }])?.mensagem).toMatch(/referência/);
    expect(
      conferirPlano([
        { comando: "criarFaixa", args: { tipo: "video" }, como: "a" },
        { comando: "criarFaixa", args: { tipo: "video" }, como: "a" },
      ])?.mensagem,
    ).toMatch(/ainda não usado/);
    const projeto = base();
    const r = executarPlano(projeto, [
      { comando: "adicionarTexto", args: { texto: "A", inicio: 0, duracao: 1 } },
      { comando: "adicionarTexto", args: { texto: "", inicio: 0, duracao: 1 } },
    ]);
    expect(r).toMatchObject({ ok: false, alterado: false });
    expect(r.relatorio).toHaveLength(1);
    expect(r.relatorio[0]!.indice).toBe(1);
  });

  it("não confunde texto com referência", () => {
    const r = executarPlano(base(), [{ comando: "adicionarTexto", args: { texto: "$47", inicio: 0, duracao: 1 } }]);
    expect(r.ok).toBe(true);
    expect(Object.values(r.projeto.materials).some((m) => m.kind === "text" && m.text === "$47")).toBe(true);
  });
});
