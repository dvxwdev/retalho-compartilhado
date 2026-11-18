#!/usr/bin/env node
/**
 * Controls the Retalho editor from the terminal, for agents and scripts.
 *
 *   npm run agente -- render plano.json            monta, confere e exporta um vídeo de um plano
 *   npm run agente -- comandos                     lista os comandos e seus argumentos
 *   npm run agente -- ajuda                        mostra todos os subcomandos
 *
 * Every run starts the editor's Vite server and a headless Chrome, works through
 * window.retalho, and closes both, even on error. The main result goes to stdout
 * as JSON; progress goes to stderr. Exit codes: 0 success, 1 plan or command
 * error, 2 environment error (no Chrome, server down, file missing).
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PERFIL_PADRAO = join(RAIZ, ".agente", "perfil");
const PEDACO = 8 * 1024 * 1024;
const MIDIA = /\.(mp4|mov|webm|mkv|m4v|mp3|wav|m4a|aac|ogg|flac|png|jpe?g|webp|gif|bmp|ttf|otf|woff2?|cube|srt)$/i;

class ErroDeAmbiente extends Error {}
class ErroDoPlano extends Error {
  constructor(mensagem, detalhes) {
    super(mensagem);
    this.detalhes = detalhes;
  }
}

const log = (...partes) => console.error("·", ...partes);

function lerArgs(argv) {
  const posicionais = [];
  const opcoes = {};
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith("--")) {
      posicionais.push(item);
      continue;
    }
    const [chave, valor] = item.slice(2).split("=", 2);
    if (valor !== undefined) opcoes[chave] = valor;
    else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith("--")) opcoes[chave] = argv[++i];
    else opcoes[chave] = true;
  }
  return { posicionais, opcoes };
}

function acharChrome() {
  const candidatos = [
    process.env.RETALHO_CHROME,
    process.env.CHROME_PATH,
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ];
  const achado = candidatos.find((caminho) => caminho && existsSync(caminho));
  if (!achado) throw new ErroDeAmbiente("Chrome ou Edge não encontrado. Defina RETALHO_CHROME com o caminho do executável.");
  return achado;
}

function portaLivre() {
  return new Promise((done, fail) => {
    const servidor = createServer();
    servidor.unref();
    servidor.on("error", fail);
    servidor.listen(0, () => {
      const { port } = servidor.address();
      servidor.close(() => done(port));
    });
  });
}

/** Opens the editor and returns the page plus a function that always closes everything. */
async function abrirEditor({ perfil }) {
  const chrome = acharChrome();
  const porta = await portaLivre();
  const base = `http://localhost:${porta}/`;
  const vite = spawn("npx", ["vite", "--port", String(porta), "--strictPort"], { cwd: RAIZ, shell: true, stdio: "ignore" });
  let browser;
  const fechar = async () => {
    await browser?.close().catch(() => {});
    if (process.platform === "win32") spawn("taskkill", ["/pid", String(vite.pid), "/T", "/F"], { stdio: "ignore" });
    else vite.kill();
  };
  try {
    for (let tentativa = 0; ; tentativa += 1) {
      try {
        if ((await fetch(base)).ok) break;
      } catch {}
      if (tentativa > 300) throw new ErroDeAmbiente("O servidor do editor (Vite) não respondeu.");
      await new Promise((done) => setTimeout(done, 200));
    }
    mkdirSync(perfil, { recursive: true });
    browser = await puppeteer.launch({
      executablePath: chrome,
      headless: true,
      userDataDir: perfil,
      protocolTimeout: 3_600_000,
      args: [
        "--autoplay-policy=no-user-gesture-required",
        "--window-size=1440,900",
        "--enable-unsafe-swiftshader",
        "--ignore-gpu-blocklist",
      ],
      defaultViewport: { width: 1440, height: 900 },
    });
    const page = await browser.newPage();
    page.on("dialog", (dialogo) => dialogo.accept());
    page.on("pageerror", (erro) => log("erro na página:", erro.message.slice(0, 300)));
    await page.goto(base);
    await page.waitForSelector('[data-testid="preview"]', { timeout: 60_000 });
    await page.waitForFunction(() => Boolean(window.retalho), { timeout: 30_000 });
    return { page, fechar };
  } catch (erro) {
    await fechar();
    throw erro;
  }
}

const chamar = (page, metodo, ...args) =>
  page.evaluate((nome, lista) => window.retalho[nome](...lista), metodo, args);

/** Files in a list, with folders opened one level deep. */
function expandirMidias(lista, pasta) {
  const arquivos = [];
  for (const item of lista) {
    const caminho = resolve(pasta, item);
    if (!existsSync(caminho)) throw new ErroDeAmbiente(`Arquivo não encontrado: ${caminho}`);
    if (statSync(caminho).isDirectory()) {
      for (const nome of readdirSync(caminho).sort()) if (MIDIA.test(nome)) arquivos.push(join(caminho, nome));
    } else arquivos.push(caminho);
  }
  const nomes = new Map();
  for (const arquivo of arquivos) {
    const nome = basename(arquivo);
    if (nomes.has(nome) && nomes.get(nome) !== arquivo) {
      throw new ErroDoPlano(`Dois arquivos com o mesmo nome, "${nome}". O plano acha mídias pelo nome, então renomeie um deles.`);
    }
    nomes.set(nome, arquivo);
  }
  return [...nomes.values()];
}

/** Imports through the editor's own file input and waits until every file is in. */
async function importar(page, arquivos) {
  const faltando = (lista) => {
    const nomes = new Set([...lista.materiais.map((m) => m.nome), ...lista.fontes.map((f) => f.nome)]);
    return arquivos.filter((arquivo) => {
      const nome = basename(arquivo);
      if (/\.(cube|srt|json|retalho)$/i.test(nome)) return false;
      return !nomes.has(nome) && !nomes.has(nome.slice(0, -extname(nome).length));
    });
  };
  const ja = await chamar(page, "midias");
  const novos = faltando(ja);
  if (novos.length === 0) return;
  const total = novos.reduce((soma, arquivo) => soma + statSync(arquivo).size, 0);
  log(`importando ${novos.length} arquivo(s), ${(total / 1e6).toFixed(1)} MB`);
  const input = await page.$('[data-testid="file-input"]');
  await input.uploadFile(...novos);
  const limite = Date.now() + 60_000 + (total / 1e6) * 2000;
  for (;;) {
    const estado = await chamar(page, "estado");
    if (estado.aviso && /não foram importados/.test(estado.aviso)) {
      throw new ErroDoPlano(`O editor recusou arquivos: ${estado.aviso}`);
    }
    const resta = faltando(await chamar(page, "midias"));
    if (resta.length === 0) break;
    if (Date.now() > limite) throw new ErroDoPlano(`Importação demorou demais. Faltam: ${resta.map((a) => basename(a)).join(", ")}`);
    await new Promise((done) => setTimeout(done, 300));
  }
  await chamar(page, "esperar");
}

/** Copies a file the bridge holds to disk, in pieces. */
async function baixar(page, { arquivo, tamanho }, destino) {
  mkdirSync(dirname(destino), { recursive: true });
  const partes = [];
  for (let inicio = 0; inicio < tamanho; inicio += PEDACO) {
    const base64 = await chamar(page, "lerArquivo", arquivo, inicio, Math.min(tamanho, inicio + PEDACO));
    partes.push(Buffer.from(base64, "base64"));
  }
  writeFileSync(destino, Buffer.concat(partes));
  await chamar(page, "liberarArquivo", arquivo);
  return destino;
}

function salvarDataUrl(dataUrl, destino) {
  mkdirSync(dirname(destino), { recursive: true });
  writeFileSync(destino, Buffer.from(dataUrl.split(",", 2)[1], "base64"));
  return destino;
}

/** Reports export progress while it runs. */
async function exportarComProgresso(page, opcoes) {
  let ativo = true;
  const relogio = (async () => {
    let ultimo = -1;
    while (ativo) {
      await new Promise((done) => setTimeout(done, 3000));
      if (!ativo) break;
      const fracao = await chamar(page, "progresso").catch(() => null);
      if (fracao !== null && Math.floor(fracao * 10) !== ultimo) {
        ultimo = Math.floor(fracao * 10);
        log(`exportando… ${Math.round(fracao * 100)}%`);
      }
    }
  })();
  try {
    return await chamar(page, "exportar", opcoes);
  } finally {
    ativo = false;
    await relogio;
  }
}

function lerJson(caminho) {
  if (!existsSync(caminho)) throw new ErroDeAmbiente(`Arquivo não encontrado: ${caminho}`);
  try {
    return JSON.parse(readFileSync(caminho, "utf8").replace(/^\uFEFF/, ""));
  } catch (erro) {
    throw new ErroDoPlano(`JSON inválido em ${caminho}: ${erro.message}`);
  }
}

/** A plan file may be a full plan or just a list of steps. */
function lerPlano(caminho) {
  const dados = lerJson(caminho);
  const plano = Array.isArray(dados) ? { passos: dados } : dados;
  if (!Array.isArray(plano.passos)) throw new ErroDoPlano("O plano precisa de uma lista em \"passos\".");
  const passos = [...plano.passos];
  if (plano.projeto) passos.unshift({ comando: "definirProjeto", args: plano.projeto });
  return { ...plano, passos, pasta: dirname(resolve(caminho)) };
}

function conferirRelatorio(resultado) {
  if (resultado.ok) return;
  const falhas = resultado.relatorio.filter((passo) => !passo.ok);
  throw new ErroDoPlano(
    falhas.map((passo) => `passo ${passo.indice} (${passo.comando}): ${passo.codigo} ${passo.mensagem}`).join("\n"),
    resultado.relatorio,
  );
}

// ---------- subcomandos ----------

/** The whole job: a plan in, a checked video, project and contact sheet out. */
async function render(page, [arquivo], opcoes) {
  if (!arquivo) throw new ErroDoPlano("Uso: render plano.json");
  const plano = lerPlano(arquivo);
  const nome = plano.nome ?? basename(arquivo, extname(arquivo));
  const saida = resolve(plano.pasta, opcoes.saida ?? plano.saida?.pasta ?? ".");
  const conf = plano.saida ?? {};

  await chamar(page, "novo", plano.projeto?.nome ?? nome);
  await importar(page, expandirMidias(plano.midias ?? [], plano.pasta));

  log(`executando ${plano.passos.length} passos`);
  const resultado = await chamar(page, "executar", plano.passos, { falharAoPrimeiroErro: plano.falharAoPrimeiroErro ?? true });
  conferirRelatorio(resultado);
  const avisos = resultado.relatorio.flatMap((passo) => passo.avisos.map((aviso) => `passo ${passo.indice} (${passo.comando}): ${aviso}`));
  for (const aviso of avisos) log("aviso:", aviso);

  const problemas = await chamar(page, "validar");
  const erros = problemas.filter((p) => p.gravidade === "erro");
  if (erros.length && !opcoes.forcar) throw new ErroDoPlano("A validação encontrou erros.", problemas);

  let audio = null;
  if (plano.audio?.lufs !== undefined || opcoes.lufs !== undefined) {
    const alvo = Number(opcoes.lufs ?? plano.audio.lufs);
    log(`normalizando o som para ${alvo} LUFS`);
    audio = await chamar(page, "normalizarAudio", { alvo, picoMax: plano.audio?.picoMax ?? -1 });
  } else {
    audio = { depois: await chamar(page, "medirAudio") };
  }

  const arquivos = {};
  if (conf.retalho !== false) {
    arquivos.projeto = await baixar(page, await chamar(page, "exportar", { formato: "retalho" }), join(saida, `${nome}.retalho`));
  }
  if (conf.folha !== false && !opcoes["sem-folha"]) {
    const folha = await chamar(page, "folha", { passo: 1, colunas: 6, largura: 220, ...(conf.folha ?? {}) });
    arquivos.folha = salvarDataUrl(folha, join(saida, `${nome}-folha.jpg`));
  }
  if (conf.mp4 !== false && !opcoes["sem-mp4"]) {
    log("exportando o MP4");
    const video = await exportarComProgresso(page, {
      formato: "mp4",
      qualidade: conf.qualidade ?? 0.2,
      lado: conf.lado ?? 0,
      ...(conf.fps ? { fps: conf.fps } : {}),
      desfoque: Boolean(conf.desfoque),
    });
    arquivos.mp4 = await baixar(page, video, join(saida, `${nome}.mp4`));
    log(`MP4 pronto em ${video.segundos} s (${video.detalhe})`);
  }
  const inspecao = await chamar(page, "inspecionar");
  return {
    ok: true,
    nome,
    duracao: inspecao.duracao,
    canvas: inspecao.canvas,
    nomes: resultado.nomes,
    avisos,
    problemas,
    audio: audio.depois,
    ...(audio.ganhoDb !== undefined ? { ganhoDb: audio.ganhoDb } : {}),
    arquivos,
  };
}

const SUBCOMANDOS = {
  render: { uso: "render <plano.json> [--saida pasta] [--sem-mp4] [--sem-folha] [--lufs -14] [--forcar]", novoPerfil: true, run: render },
  comandos: { uso: "comandos", run: (page) => chamar(page, "comandos") },
  inspecionar: { uso: "inspecionar", run: (page) => chamar(page, "inspecionar") },
  validar: { uso: "validar", run: (page) => chamar(page, "validar") },
  midias: { uso: "midias", run: (page) => chamar(page, "midias") },
  novo: { uso: "novo [--nome X]", run: (page, _p, o) => chamar(page, "novo", typeof o.nome === "string" ? o.nome : undefined).then(() => ({ ok: true })) },
  importar: {
    uso: "importar <arquivos ou pastas...>",
    run: async (page, posicionais) => {
      await importar(page, expandirMidias(posicionais, process.cwd()));
      return chamar(page, "midias");
    },
  },
  carregar: {
    uso: "carregar <projeto.retalho>",
    run: async (page, [arquivo]) => {
      if (!arquivo) throw new ErroDoPlano("Uso: carregar projeto.retalho");
      const input = await page.$('[data-testid="file-input"]');
      await input.uploadFile(resolve(arquivo));
      await page.waitForFunction(() => window.retalho.estado().tarefa === null, { timeout: 600_000 });
      await new Promise((done) => setTimeout(done, 1000));
      await chamar(page, "esperar");
      return chamar(page, "inspecionar");
    },
  },
  executar: {
    uso: "executar <plano.json> [--simular] [--continuar]",
    run: async (page, [arquivo], opcoes) => {
      if (!arquivo) throw new ErroDoPlano("Uso: executar plano.json");
      const plano = lerPlano(arquivo);
      if (plano.midias?.length) await importar(page, expandirMidias(plano.midias, plano.pasta));
      const resultado = await chamar(page, "executar", plano.passos, {
        simular: Boolean(opcoes.simular),
        falharAoPrimeiroErro: !opcoes.continuar && (plano.falharAoPrimeiroErro ?? true),
      });
      if (!opcoes.continuar) conferirRelatorio(resultado);
      return resultado;
    },
  },
  quadro: {
    uso: "quadro <tempo> --saida quadro.png",
    run: async (page, [tempo], opcoes) => {
      const destino = resolve(opcoes.saida ?? `quadro-${tempo}.png`);
      return { arquivo: salvarDataUrl(await chamar(page, "quadro", Number(tempo ?? 0)), destino) };
    },
  },
  folha: {
    uso: "folha [--de 0] [--ate 10] [--passo 1] [--colunas 6] [--largura 220] --saida folha.jpg",
    run: async (page, _p, opcoes) => {
      const numero = (chave) => (opcoes[chave] === undefined ? undefined : Number(opcoes[chave]));
      const dataUrl = await chamar(page, "folha", {
        de: numero("de"),
        ate: numero("ate"),
        passo: numero("passo"),
        colunas: numero("colunas"),
        largura: numero("largura"),
      });
      return { arquivo: salvarDataUrl(dataUrl, resolve(opcoes.saida ?? "folha.jpg")) };
    },
  },
  audio: {
    uso: "audio [--normalizar -14] [--pico -1]",
    run: (page, _p, opcoes) =>
      opcoes.normalizar !== undefined
        ? chamar(page, "normalizarAudio", { alvo: Number(opcoes.normalizar === true ? -14 : opcoes.normalizar), picoMax: Number(opcoes.pico ?? -1) })
        : chamar(page, "medirAudio"),
  },
  exportar: {
    uso: "exportar [--formato mp4|wav|png|srt|retalho] [--qualidade 0.2] [--lado 1080] [--fps 30] [--tempo 0] --saida arquivo",
    run: async (page, _p, opcoes) => {
      const formato = opcoes.formato ?? "mp4";
      const resultado = await exportarComProgresso(page, {
        formato,
        ...(opcoes.qualidade ? { qualidade: Number(opcoes.qualidade) } : {}),
        ...(opcoes.lado ? { lado: Number(opcoes.lado) } : {}),
        ...(opcoes.fps ? { fps: Number(opcoes.fps) } : {}),
        ...(opcoes.tempo ? { tempo: Number(opcoes.tempo) } : {}),
        desfoque: Boolean(opcoes.desfoque),
      });
      const destino = resolve(opcoes.saida ?? `saida.${formato}`);
      return { arquivo: await baixar(page, resultado, destino), detalhe: resultado.detalhe, segundos: resultado.segundos };
    },
  },
  salvar: {
    uso: "salvar --saida projeto.retalho",
    run: async (page, _p, opcoes) => ({
      arquivo: await baixar(page, await chamar(page, "exportar", { formato: "retalho" }), resolve(opcoes.saida ?? "projeto.retalho")),
    }),
  },
};

function ajuda() {
  console.error("Uso: npm run agente -- <subcomando> [opções]\n");
  for (const { uso } of Object.values(SUBCOMANDOS)) console.error(`  ${uso}`);
  console.error(
    "\nrender usa um perfil de navegador novo a cada vez. Os outros subcomandos guardam o projeto em .agente/perfil,\n" +
      "então importar, executar, folha e exportar continuam o mesmo projeto entre chamadas. --perfil escolhe outra pasta.\n" +
      "O guia completo está em docs/AGENTE.md.",
  );
}

async function main() {
  const [subcomando, ...resto] = process.argv.slice(2);
  if (!subcomando || subcomando === "ajuda" || subcomando === "--help") {
    ajuda();
    return 0;
  }
  const alvo = SUBCOMANDOS[subcomando];
  if (!alvo) {
    console.error(`Subcomando desconhecido: ${subcomando}\n`);
    ajuda();
    return 1;
  }
  const { posicionais, opcoes } = lerArgs(resto);
  let temporario = null;
  let perfil = opcoes.perfil ? resolve(opcoes.perfil) : PERFIL_PADRAO;
  if (alvo.novoPerfil && !opcoes.perfil) {
    temporario = mkdtempSync(join(tmpdir(), "retalho-agente-"));
    perfil = temporario;
  }
  let editor;
  try {
    editor = await abrirEditor({ perfil });
    const resultado = await alvo.run(editor.page, posicionais, opcoes);
    // The next call opens this same profile, so the project is saved before the browser closes.
    if (!temporario) await chamar(editor.page, "gravar");
    console.log(JSON.stringify(resultado, null, 2));
    return 0;
  } catch (erro) {
    const ambiente = erro instanceof ErroDeAmbiente;
    console.log(JSON.stringify({ ok: false, erro: erro.message, ...(erro.detalhes ? { detalhes: erro.detalhes } : {}) }, null, 2));
    console.error(`✗ ${erro.message}`);
    return ambiente ? 2 : 1;
  } finally {
    await editor?.fechar();
    if (temporario) {
      // Chrome may still hold the profile for a moment after closing.
      for (let tentativa = 0; tentativa < 10; tentativa += 1) {
        try {
          rmSync(temporario, { recursive: true, force: true });
          break;
        } catch {
          await new Promise((done) => setTimeout(done, 300));
        }
      }
    }
  }
}

process.exitCode = await main();
