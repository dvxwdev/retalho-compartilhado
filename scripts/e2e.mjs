/**
 * Drives the real editor in Chrome: imports media, edits through the UI, exports
 * an MP4 and verifies the bytes that came out. Run with `npm run e2e`. Set
 * RETALHO_REAL_DRAFT to a draft_content.json to also exercise a real import, and
 * RETALHO_SPEECH_WAV to a recording of the test sentences to exercise real speech
 * recognition, which downloads the model on the first run.
 */
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import puppeteer from "puppeteer-core";

const PORT = 5199;
const URL_BASE = `http://localhost:${PORT}/`;
const OUT = resolve(".e2e");
const CHROME = [
  process.env.CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
].find((path) => path && existsSync(path));
/** Decodes outside Chrome. Optional, because it comes from a local CapCut install. */
const FFMPEG = [
  process.env.FFMPEG_PATH,
  join(process.env.LOCALAPPDATA ?? "", "CapCut/Apps/9.1.0.3879/ffmpeg.exe"),
].find((path) => path && existsSync(path));

const results = [];
function check(name, passed, detail = "") {
  results.push(passed);
  console.log(`${passed ? "ok  " : "FAIL"} ${name}${detail ? `  (${detail})` : ""}`);
}

/** Wraps mono samples in a 16-bit, 48 kHz WAV file. */
function wavFrom(values) {
  const rate = 48000;
  const samples = values.length;
  const buffer = Buffer.alloc(44 + samples * 2);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + samples * 2, 4);
  buffer.write("WAVEfmt ", 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(rate, 24);
  buffer.writeUInt32LE(rate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(samples * 2, 40);
  for (let index = 0; index < samples; index += 1) {
    const value = Math.max(-1, Math.min(1, values[index])) * 32767;
    buffer.writeInt16LE(Math.round(value), 44 + index * 2);
  }
  return buffer;
}

function wavFile(seconds, frequency) {
  const values = new Float32Array(seconds * 48000);
  for (let index = 0; index < values.length; index += 1) {
    values[index] = Math.sin((2 * Math.PI * frequency * index) / 48000) * 0.5;
  }
  return wavFrom(values);
}

/** A second of tone, a second of silence and another second of tone. */
function pausedTone() {
  const values = new Float32Array(3 * 48000);
  for (let index = 0; index < values.length; index += 1) {
    const silent = index >= 48000 && index < 96000;
    values[index] = silent ? 0 : 0.4 * Math.sin((2 * Math.PI * 200 * index) / 48000);
  }
  return wavFrom(values);
}

/** A colour table that turns every colour into its opposite. */
function invertCube() {
  const rows = ["LUT_3D_SIZE 2"];
  for (const blue of [0, 1]) {
    for (const green of [0, 1]) {
      for (const red of [0, 1]) rows.push(`${1 - red} ${1 - green} ${1 - blue}`);
    }
  }
  return rows.join("\n");
}

/** Kick-like bursts at a tempo, the first at 0.3s. */
function clickTrack(seconds, bpm) {
  const values = new Float32Array(seconds * 48000);
  for (let time = 0.3; time < seconds - 0.2; time += 60 / bpm) {
    const start = Math.round(time * 48000);
    for (let index = 0; index < 4000; index += 1) {
      values[start + index] += 0.8 * Math.exp(-index / 800) * Math.sin((2 * Math.PI * 90 * index) / 48000);
    }
  }
  return wavFrom(values);
}

/** One second of steady noise, then a tone over the same noise. */
function noisyTone(seconds) {
  const values = new Float32Array(seconds * 48000);
  let seed = 4242;
  for (let index = 0; index < values.length; index += 1) {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    values[index] = (seed / 4294967296 - 0.5) * 0.06;
    if (index >= 48000) values[index] += 0.3 * Math.sin((2 * Math.PI * 1000 * index) / 48000);
  }
  return wavFrom(values);
}

/**
 * Encodes a video frame by frame, so its content is exact: red until 2.000s, then
 * green, with a tone on the audio track. A recording would vary between runs.
 */
async function makeFixtures(page) {
  const result = await page.evaluate(async () => {
    const { Muxer, ArrayBufferTarget } = await import("/node_modules/mp4-muxer/build/mp4-muxer.mjs");
    const toBase64 = async (blob) => {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let text = "";
      for (let index = 0; index < bytes.length; index += 8192) {
        text += String.fromCharCode(...bytes.subarray(index, index + 8192));
      }
      return btoa(text);
    };
    const canvas = document.createElement("canvas");
    canvas.width = 640;
    canvas.height = 360;
    const context = canvas.getContext("2d");
    const paint = (color) => {
      context.fillStyle = color;
      context.fillRect(0, 0, 640, 360);
    };
    const muxer = new Muxer({
      target: new ArrayBufferTarget(),
      fastStart: "in-memory",
      video: { codec: "avc", width: 640, height: 360, frameRate: 30 },
      audio: { codec: "aac", numberOfChannels: 1, sampleRate: 48000 },
    });
    const fail = (error) => {
      throw error;
    };
    const video = new VideoEncoder({ output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: fail });
    video.configure({ codec: "avc1.42001f", width: 640, height: 360, bitrate: 2_000_000, framerate: 30 });
    for (let index = 0; index < 120; index += 1) {
      paint(index < 60 ? "#ff0000" : "#00ff00");
      const frame = new VideoFrame(canvas, { timestamp: Math.round((index * 1e6) / 30), duration: 33333 });
      video.encode(frame, { keyFrame: index % 15 === 0 });
      frame.close();
    }
    await video.flush();
    const audio = new AudioEncoder({ output: (chunk, meta) => muxer.addAudioChunk(chunk, meta), error: fail });
    audio.configure({ codec: "mp4a.40.2", sampleRate: 48000, numberOfChannels: 1, bitrate: 128000 });
    const samples = new Float32Array(48000 * 4);
    for (let index = 0; index < samples.length; index += 1) {
      samples[index] = Math.sin((2 * Math.PI * 220 * index) / 48000) * 0.3;
    }
    for (let start = 0; start < samples.length; start += 4800) {
      const data = new AudioData({
        format: "f32-planar",
        sampleRate: 48000,
        numberOfFrames: 4800,
        numberOfChannels: 1,
        timestamp: Math.round((start / 48000) * 1e6),
        data: samples.slice(start, start + 4800),
      });
      audio.encode(data);
      data.close();
    }
    await audio.flush();
    muxer.finalize();
    paint("#0000ff");
    const png = await new Promise((done) => canvas.toBlob(done, "image/png"));
    context.fillStyle = "#ffff00";
    context.fillRect(320, 0, 320, 360);
    const split = await new Promise((done) => canvas.toBlob(done, "image/png"));
    return {
      video: await toBase64(new Blob([muxer.target.buffer])),
      png: await toBase64(png),
      split: await toBase64(split),
    };
  });
  const paths = {
    video: join(OUT, "teste.mp4"),
    image: join(OUT, "azul.png"),
    split: join(OUT, "metades.png"),
    audio: join(OUT, "tom.wav"),
  };
  writeFileSync(paths.video, Buffer.from(result.video, "base64"));
  writeFileSync(paths.image, Buffer.from(result.png, "base64"));
  writeFileSync(paths.split, Buffer.from(result.split, "base64"));
  writeFileSync(paths.audio, wavFile(3, 440));
  return paths;
}

const state = (page) =>
  page.evaluate(() => {
    const current = window.__retalho.getState();
    return {
      playhead: current.playhead,
      playing: current.playing,
      selection: current.selection,
      canUndo: current.canUndo,
      notice: current.notice,
      materials: Object.values(current.project.materials).map((item) => ({
        kind: item.kind,
        name: item.name,
        offline: item.offline,
      })),
      tracks: current.project.tracks.map((track) => ({
        type: track.type,
        segments: track.segments.map((segment) => ({
          id: segment.id,
          target: segment.target,
          source: segment.source,
          transition: segment.transitionOut,
        })),
      })),
    };
  });

async function seek(page, seconds) {
  const ruler = await page.$('[data-testid="ruler"]');
  const box = await ruler.boundingBox();
  const zoom = await page.evaluate(() => window.__retalho.getState().zoom);
  await page.mouse.click(box.x + seconds * zoom, box.y + 10);
}

/** The whole project, for checks on fields the summary in state() leaves out. */
const project = (page) => page.evaluate(() => window.__retalho.getState().project);

async function clickButton(page, text) {
  const button = await page.evaluateHandle(
    (label) => [...document.querySelectorAll("button")].find((item) => item.textContent === label),
    text,
  );
  await button.click();
}

async function shortcut(page, key) {
  await page.keyboard.down("Control");
  await page.keyboard.press(key);
  await page.keyboard.up("Control");
}

/** Runs an export with the dialog left open and returns the download address. */
async function runExport(page, { format, resolution, fps, stretch } = {}) {
  await page.click('[data-testid="export-open"]');
  await page.waitForSelector('[data-testid="export-start"]');
  if (format) await page.select('[data-testid="export-format"]', format);
  if (resolution) await page.select('[data-testid="export-resolution"]', resolution);
  if (fps) await page.select('[data-testid="export-fps"]', fps);
  if (stretch) await page.select('[data-testid="export-stretch"]', stretch);
  await page.click('[data-testid="export-start"]');
  await page.waitForSelector('[data-testid="export-done"], .dialog .warning', { timeout: 120000 });
  return page.$eval('[data-testid="export-link"]', (link) => link.href);
}

const openPanel = async (page, id) => {
  await page.waitForSelector(`[data-testid="tab-${id}"]`);
  await page.click(`[data-testid="tab-${id}"]`);
};

const openSection = async (page, tab, section) => {
  await openPanel(page, tab);
  await page.waitForSelector(`[data-testid="sub-${section}"]`);
  await page.click(`[data-testid="sub-${section}"]`);
};

const choose = (page, group, value) => page.click(`[data-testid="${group}-${value || "none"}"]`);

const settle = () => new Promise((done) => setTimeout(done, 500));

/** Sets a controlled input the way a person typing would, so React sees the change. */
async function setInput(page, selector, value) {
  await page.$eval(
    selector,
    (element, next) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(element, next);
      element.dispatchEvent(new Event("input", { bubbles: true }));
    },
    value,
  );
}

async function deselect(page) {
  const lane = await (await page.$(".lane-body")).boundingBox();
  await page.mouse.click(1400, lane.y + 10);
}

/** Counts preview pixels matching an expression on r, g and b, and how far down they reach. */
function countPixels(page, expression) {
  return page.evaluate((source) => {
    const test = new Function("r", "g", "b", `return ${source}`);
    const canvas = document.querySelector('[data-testid="preview"]');
    const { data } = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height);
    let count = 0;
    let top = canvas.height;
    let bottom = 0;
    for (let index = 0; index < data.length; index += 4) {
      if (!test(data[index], data[index + 1], data[index + 2])) continue;
      const y = Math.floor(index / 4 / canvas.width);
      count += 1;
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
    }
    return { count, top, bottom };
  }, expression);
}

function imageInfo(page, href, x, y) {
  return page.evaluate(
    async (url, px, py) => {
      const bitmap = await createImageBitmap(await (await fetch(url)).blob());
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext("2d");
      context.drawImage(bitmap, 0, 0);
      return { width: bitmap.width, height: bitmap.height, pixel: [...context.getImageData(px, py, 1, 1).data] };
    },
    href,
    x,
    y,
  );
}

async function saveDownload(page, href, name) {
  const encoded = await page.evaluate(async (url) => {
    const saved = new Uint8Array(await (await (await fetch(url)).blob()).arrayBuffer());
    let binary = "";
    for (let index = 0; index < saved.length; index += 8192) {
      binary += String.fromCharCode(...saved.subarray(index, index + 8192));
    }
    return btoa(binary);
  }, href);
  const path = join(OUT, name);
  writeFileSync(path, Buffer.from(encoded, "base64"));
  return path;
}

/** One pixel of a frame decoded outside Chrome, on a 64 by 36 thumbnail. */
function ffmpegPixel(path, seconds, x, y) {
  const raw = spawnSync(
    FFMPEG,
    ["-v", "error", "-ss", String(seconds), "-i", path, "-frames:v", "1", "-vf", "scale=64:36", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
    { maxBuffer: 1 << 20 },
  ).stdout;
  const offset = (y * 64 + x) * 3;
  return [...raw.subarray(offset, offset + 3)];
}

async function clickBinItem(page, index) {
  const buttons = await page.$$('[data-testid="bin-add"]');
  await buttons[index].click();
}

const server = spawn("npx", ["vite", "--port", String(PORT), "--strictPort"], {
  shell: true,
  stdio: "ignore",
});

async function waitForServer() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      if ((await fetch(URL_BASE)).ok) return;
    } catch {
      await new Promise((done) => setTimeout(done, 200));
    }
  }
  throw new Error("O servidor Vite não iniciou");
}

let browser;
try {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  await waitForServer();
  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    protocolTimeout: 600000,
    args: [
      "--autoplay-policy=no-user-gesture-required",
      "--window-size=1440,900",
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      "--enable-unsafe-swiftshader",
    ],
    defaultViewport: { width: 1440, height: 900 },
  });
  const page = await browser.newPage();
  page.on("dialog", (dialog) => dialog.accept());
  const errors = [];
  page.on("pageerror", (error) => {
    errors.push(error.message);
    console.log(`     erro na página: ${error.message.slice(0, 300)}`);
  });
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.goto(URL_BASE);
  await page.waitForSelector('[data-testid="preview"]');

  const paths = await makeFixtures(page);
  const input = await page.$('[data-testid="file-input"]');
  await input.uploadFile(paths.video, paths.image, paths.audio);
  await page.waitForFunction(
    () => Object.keys(window.__retalho.getState().project.materials).length === 3,
    { timeout: 20000 },
  );
  let current = await state(page);
  check("importa vídeo, imagem e áudio", current.materials.length === 3, current.materials.map((m) => m.kind).join(","));

  await clickBinItem(page, 0);
  await page.waitForSelector(".clip");
  await seek(page, 2);
  await page.click('[data-testid="split"]');
  current = await state(page);
  const main = current.tracks[0].segments;
  check("corta o clipe no cursor", main.length === 2 && Math.abs(main[1].target.start - 2_000_000) < 40_000, `${main.length} clipes`);

  const undoButton = await page.evaluateHandle(() =>
    [...document.querySelectorAll("button")].find((button) => button.textContent === "Desfazer"),
  );
  await undoButton.click();
  check("desfaz o corte", (await state(page)).tracks[0].segments.length === 1);
  await page.keyboard.down("Control");
  await page.keyboard.press("y");
  await page.keyboard.up("Control");
  check("refaz o corte", (await state(page)).tracks[0].segments.length === 2);

  const clips = await page.$$('.clip-video');
  await clips[0].click();
  await openPanel(page, "transition");
  await page.waitForSelector('[data-testid="transition"]');
  await choose(page, "transition", "fade");
  current = await state(page);
  check("aplica transição entre os clipes", current.tracks[0].segments[0].transition?.type === "fade");

  await seek(page, 2.5);
  await clickBinItem(page, 1);
  await seek(page, 0);
  await clickBinItem(page, 2);
  await seek(page, 0.2);
  await page.click('[data-testid="add-text"]');
  await page.waitForSelector('[data-testid="text-content"]');
  await page.click('[data-testid="text-content"]', { count: 3 });
  await page.keyboard.type("Retalho");
  current = await state(page);
  check(
    "monta faixas de vídeo, texto e áudio",
    ["video", "text", "audio"].every((type) => current.tracks.some((track) => track.type === type)),
    current.tracks.map((track) => track.type).join(","),
  );

  await seek(page, 1);
  await new Promise((done) => setTimeout(done, 500));
  await page.screenshot({ path: join(OUT, "editor.png") });
  const previewPixel = (x, y) =>
    page.evaluate(
      (px, py) => {
        const canvas = document.querySelector('[data-testid="preview"]');
        return [...canvas.getContext("2d").getImageData(px, py, 1, 1).data];
      },
      x,
      y,
    );
  const still = await previewPixel(20, 20);
  check("mostra o quadro exato pausado", still[0] > 200 && still[1] < 60, still.join(","));

  await seek(page, 0);
  await page.click('[data-testid="play"]');
  await new Promise((done) => setTimeout(done, 1500));
  const during = await state(page);
  await page.click('[data-testid="play"]');
  check("reproduz em tempo real", during.playing && during.playhead > 900_000, `${during.playhead}µs`);

  await page.click('[data-testid="export-open"]');
  await page.waitForSelector('[data-testid="export-start"]');
  await page.click('[data-testid="export-start"]');
  const exportStart = Date.now();
  await page.waitForSelector('[data-testid="export-done"], .warning', { timeout: 120000 });
  console.log(`     exportação: ${((Date.now() - exportStart) / 1000).toFixed(1)}s`);
  const doneText = await page.$eval(".dialog", (element) => element.textContent);
  const exported = await page.$('[data-testid="export-link"]');
  check("exporta MP4", Boolean(exported), doneText.slice(-60));

  if (exported) {
    const verification = await page.evaluate(async () => {
      const href = document.querySelector('[data-testid="export-link"]').href;
      const blob = await (await fetch(href)).blob();
      const saved = new Uint8Array(await blob.arrayBuffer());
      let binary = "";
      for (let index = 0; index < saved.length; index += 8192) {
        binary += String.fromCharCode(...saved.subarray(index, index + 8192));
      }
      window.__exported = btoa(binary);
      const video = document.createElement("video");
      video.muted = true;
      video.src = href;
      await new Promise((done, fail) => {
        video.onloadeddata = done;
        video.onerror = () => fail(new Error("vídeo inválido"));
      });
      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const context = canvas.getContext("2d");
      const pixelAt = async (seconds) => {
        // Same rule as the editor: seeked alone does not mean the frame is drawable.
        await new Promise((done) => {
          // A frame can miss the wanted time by a little, which must not hang the whole run.
          setTimeout(done, 3000);
          const onFrame = (_now, metadata) => {
            if (Math.abs(metadata.mediaTime - seconds) <= 0.02) done();
            else video.requestVideoFrameCallback(onFrame);
          };
          video.requestVideoFrameCallback(onFrame);
          video.currentTime = seconds;
        });
        context.drawImage(video, 0, 0);
        return [...context.getImageData(30, 30, 1, 1).data].slice(0, 3);
      };
      const pixels = { red: await pixelAt(1), mid: await pixelAt(2.15), blue: await pixelAt(3.5) };
      const audioContext = new OfflineAudioContext(2, 1, 48000);
      const decoded = await audioContext.decodeAudioData(await blob.arrayBuffer());
      const channel = decoded.getChannelData(0);
      let peak = 0;
      for (let index = 0; index < 96000; index += 1) peak = Math.max(peak, Math.abs(channel[index]));
      const bytes = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
      return {
        duration: video.duration,
        width: video.videoWidth,
        height: video.videoHeight,
        pixels,
        peak,
        audioDuration: decoded.duration,
        brand: String.fromCharCode(...bytes.slice(4, 8)),
        size: blob.size,
      };
    });
    writeFileSync(join(OUT, "saida.mp4"), Buffer.from(await page.evaluate(() => window.__exported), "base64"));
    const { duration, pixels, peak, width, height } = verification;
    console.log("     ", JSON.stringify(verification));
    const final = await state(page);
    const expected =
      Math.max(
        ...final.tracks.map((track) => {
          const last = track.segments[track.segments.length - 1];
          return last.target.start + last.target.duration;
        }),
      ) / 1e6;
    check("arquivo é MP4 válido", verification.brand === "ftyp" && width === 1920 && height === 1080, `${width}x${height}`);
    check("duração bate com a timeline", Math.abs(duration - expected) < 0.1, `${duration.toFixed(2)}s de ${expected.toFixed(2)}s`);
    check("conteúdo do vídeo no tempo certo", pixels.red[0] > 180 && pixels.red[1] < 80, pixels.red.join(","));
    check("camada sobreposta presente", pixels.blue[2] > 180 && pixels.blue[0] < 80, pixels.blue.join(","));
    check("dissolve mistura os dois lados", Math.abs(pixels.mid[0] - 51) < 30 && Math.abs(pixels.mid[1] - 204) < 30, pixels.mid.join(","));
    check("áudio presente no arquivo", peak > 0.05, `pico ${peak.toFixed(3)}`);
  }

  await new Promise((done) => setTimeout(done, 700));
  const before = await state(page);
  await page.reload();
  await page.waitForSelector('[data-testid="preview"]');
  await page.waitForSelector(".clip");
  const after = await state(page);
  check(
    "restaura o projeto ao recarregar",
    JSON.stringify(after.tracks) === JSON.stringify(before.tracks) && after.materials.every((m) => !m.offline),
  );

  await clickButton(page, "Novo");
  await page.waitForFunction(() => window.__retalho.getState().project.tracks.length === 0);
  const fileInput = await page.$('[data-testid="file-input"]');
  await fileInput.uploadFile(paths.video, paths.split, paths.audio);
  await page.waitForFunction(
    () => Object.keys(window.__retalho.getState().project.materials).length === 3,
    { timeout: 20000 },
  );
  await clickBinItem(page, 0);
  await page.waitForSelector(".clip");

  await page.click(".clip-video");
  await page.click('[data-testid="track-lock"]');
  await page.keyboard.press("Delete");
  check("faixa bloqueada recusa excluir", (await project(page)).tracks[0].segments.length === 1);
  await page.click('[data-testid="track-lock"]');

  await seek(page, 1);
  await page.click('[data-testid="add-marker"]');
  await seek(page, 0);
  await page.keyboard.press("]");
  const jumped = await state(page);
  check(
    "marcador aparece e o atalho vai até ele",
    (await page.$$('[data-testid="marker"]')).length === 1 && Math.abs(jumped.playhead - 1_000_000) < 40_000,
    `${jumped.playhead}µs`,
  );

  await page.click(".clip-video");
  await shortcut(page, "c");
  await seek(page, 5);
  await shortcut(page, "v");
  await shortcut(page, "d");
  const copied = (await project(page)).tracks[0].segments.map((segment) => Math.round(segment.target.start / 1e5) / 10);
  check("copia, cola e duplica pelo teclado", copied.length === 3 && copied[1] === 5 && copied[2] === 9, copied.join(" "));
  await shortcut(page, "z");
  await shortcut(page, "z");
  check("desfaz colar e duplicar", (await project(page)).tracks[0].segments.length === 1);

  await seek(page, 1);
  await page.click(".clip-video");
  await page.click('[data-testid="freeze"]');
  const frozen = (await project(page)).tracks[0].segments;
  check("congela o quadro", frozen.length === 3 && frozen[1].frozen === true, frozen.map((s) => s.target.duration / 1e6).join(" "));

  await seek(page, 0);
  await page.click('[data-testid="play"]');
  await new Promise((done) => setTimeout(done, 2400));
  const frozenLive = await previewPixel(20, 20);
  const frozenTime = (await state(page)).playhead;
  await page.click('[data-testid="play"]');
  check(
    "quadro congelado não anda na reprodução",
    frozenTime > 1_300_000 && frozenTime < 3_900_000 && frozenLive[0] > 200 && frozenLive[1] < 60,
    `${(frozenTime / 1e6).toFixed(2)}s ${frozenLive.join(",")}`,
  );

  await seek(page, 0.5);
  await clickBinItem(page, 1);
  await new Promise((done) => setTimeout(done, 500));
  const normal = await previewPixel(20, 20);
  check("imagem cobre o vídeo sem mistura", normal[2] > 200 && normal[0] < 60, normal.join(","));
  await openPanel(page, "position");
  await page.click('[data-testid="flip-x"]');
  await new Promise((done) => setTimeout(done, 500));
  const flipped = await previewPixel(20, 20);
  check("espelha a imagem", flipped[0] > 200 && flipped[1] > 200 && flipped[2] < 60, flipped.join(","));
  await page.select('[data-testid="blend"]', "multiply");
  await new Promise((done) => setTimeout(done, 500));
  const blendedLeft = await previewPixel(20, 20);
  const blendedRight = await previewPixel(1200, 20);
  check(
    "mistura multiplicar combina com a camada de baixo",
    blendedLeft[0] > 200 && blendedLeft[1] < 60 && blendedRight[0] < 60 && blendedRight[2] < 60,
    `${blendedLeft.join(",")} / ${blendedRight.join(",")}`,
  );

  const stillUrl = await runExport(page, { format: "png" });
  const stillInfo = await page.evaluate(async (href) => {
    const bitmap = await createImageBitmap(await (await fetch(href)).blob());
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d");
    context.drawImage(bitmap, 0, 0);
    return { width: bitmap.width, height: bitmap.height, pixel: [...context.getImageData(30, 30, 1, 1).data] };
  }, stillUrl);
  await page.click('[data-testid="export-close"]');
  check(
    "exporta o quadro atual em PNG",
    stillInfo.width === 1920 && stillInfo.height === 1080 && stillInfo.pixel[0] > 200 && stillInfo.pixel[1] < 60,
    `${stillInfo.width}x${stillInfo.height} ${stillInfo.pixel.join(",")}`,
  );

  const firstClip = (await project(page)).tracks[0].segments[0].id;
  await page.click(`[data-segment-id="${firstClip}"]`);
  await page.click('[data-testid="extract-audio"]');
  const extracted = await project(page);
  const extractedAudio = extracted.tracks.find((track) => track.type === "audio");
  check(
    "extrai o áudio para outra faixa",
    extracted.tracks[0].segments[0].volume === 0 && extractedAudio?.segments.length === 1,
  );

  const wavUrl = await runExport(page, { format: "wav" });
  const wav = await page.evaluate(async (href) => {
    const blob = await (await fetch(href)).blob();
    const bytes = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
    const decoded = await new OfflineAudioContext(2, 1, 48000).decodeAudioData(await blob.arrayBuffer());
    const channel = decoded.getChannelData(0);
    const peak = (from, to) => {
      let value = 0;
      for (let index = from * 48000; index < to * 48000; index += 1) value = Math.max(value, Math.abs(channel[index]));
      return value;
    };
    return {
      tag: String.fromCharCode(...bytes.slice(0, 4)),
      duration: decoded.duration,
      extracted: peak(0.1, 0.9),
      frozen: peak(1.2, 3.8),
      after: peak(4.2, 6.8),
    };
  }, wavUrl);
  await page.click('[data-testid="export-close"]');
  check(
    "WAV tem som no clipe extraído e silêncio no quadro congelado",
    wav.tag === "RIFF" && wav.extracted > 0.1 && wav.frozen < 0.001 && wav.after > 0.1,
    `${wav.duration.toFixed(2)}s picos ${wav.extracted.toFixed(3)} ${wav.frozen.toFixed(4)} ${wav.after.toFixed(3)}`,
  );

  await seek(page, 0);
  await page.click('[data-testid="narration"]');
  await page.waitForFunction(() => window.__retalho.getState().recording);
  await new Promise((done) => setTimeout(done, 1300));
  await page.click('[data-testid="narration"]');
  await page.waitForFunction(
    () => Object.values(window.__retalho.getState().project.materials).some((item) => item.name?.startsWith("narracao")),
    { timeout: 15000 },
  );
  await page.waitForFunction(() => window.__retalho.getState().selection !== null);
  const narrated = await project(page);
  const take = narrated.tracks
    .flatMap((track) => track.segments)
    .find((segment) => narrated.materials[segment.materialId].name?.startsWith("narracao"));
  check(
    "grava narração e coloca onde começou",
    take && take.target.start === 0 && take.target.duration > 800_000 && take.target.duration < 3_000_000,
    take ? `${(take.target.duration / 1e6).toFixed(2)}s` : "sem clipe",
  );

  const srtPath = join(OUT, "legenda.srt");
  writeFileSync(srtPath, Buffer.from("1\r\n00:00:01,000 --> 00:00:02,500\r\nInformação\r\n\r\n", "latin1"));
  await fileInput.uploadFile(srtPath);
  await page.waitForFunction(() => window.__retalho.getState().project.tracks.some((track) => track.name === "Legendas"));
  const srtUrl = await runExport(page, { format: "srt" });
  const srtText = await page.evaluate(async (href) => (await fetch(href)).text(), srtUrl);
  await page.click('[data-testid="export-close"]');
  check(
    "importa SRT em Windows-1252 e exporta de volta",
    srtText.includes("00:00:01,000 --> 00:00:02,500") && srtText.includes("Informação"),
    JSON.stringify(srtText),
  );

  const smallUrl = await runExport(page, { resolution: "720", fps: "24" });
  const small = await page.evaluate(async (href) => {
    const blob = await (await fetch(href)).blob();
    const saved = new Uint8Array(await blob.arrayBuffer());
    let binary = "";
    for (let index = 0; index < saved.length; index += 8192) {
      binary += String.fromCharCode(...saved.subarray(index, index + 8192));
    }
    return btoa(binary);
  }, smallUrl);
  await page.click('[data-testid="export-close"]');
  const smallPath = join(OUT, "saida-720p24.mp4");
  writeFileSync(smallPath, Buffer.from(small, "base64"));
  if (FFMPEG) {
    const info = spawnSync(FFMPEG, ["-hide_banner", "-i", smallPath], { encoding: "utf8" }).stderr;
    check("ffmpeg confirma 1280x720 a 24 fps", /1280x720/.test(info) && /\b24 fps/.test(info), /Video:.*/.exec(info)?.[0].slice(0, 90));
    const sample = (seconds) => {
      const raw = spawnSync(
        FFMPEG,
        ["-v", "error", "-ss", String(seconds), "-i", smallPath, "-frames:v", "1", "-vf", "scale=64:36", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
        { maxBuffer: 1 << 20 },
      ).stdout;
      return [...raw.subarray(0, 3)];
    };
    const held = sample(3.5);
    const later = sample(6.5);
    check(
      "ffmpeg vê o quadro congelado e o vídeo voltando depois",
      held[0] > 180 && held[1] < 80 && later[1] > 180 && later[0] < 80,
      `${held.join(",")} / ${later.join(",")}`,
    );
  }

  const beforeFile = await project(page);
  const packed = await page.evaluate(async () => {
    const saved = new Uint8Array(await window.__retalho.buildProjectFile().arrayBuffer());
    let binary = "";
    for (let index = 0; index < saved.length; index += 8192) {
      binary += String.fromCharCode(...saved.subarray(index, index + 8192));
    }
    return btoa(binary);
  });
  const projectPath = join(OUT, "projeto.retalho");
  writeFileSync(projectPath, Buffer.from(packed, "base64"));

  const badPath = join(OUT, "ruim.retalho");
  writeFileSync(badPath, "isto não é um projeto");
  const projectInput = await page.$('[data-testid="project-input"]');
  await projectInput.uploadFile(badPath);
  await page.waitForSelector('[data-testid="notice"]', { timeout: 15000 });
  const afterBad = await project(page);
  check("arquivo inválido não apaga o projeto atual", JSON.stringify(afterBad.tracks) === JSON.stringify(beforeFile.tracks));
  await page.click('[aria-label="Fechar aviso"]');

  await clickButton(page, "Novo");
  await page.waitForFunction(() => window.__retalho.getState().project.tracks.length === 0);
  await projectInput.uploadFile(projectPath);
  await page.waitForFunction(() => window.__retalho.getState().project.tracks.length > 0, { timeout: 20000 });
  await new Promise((done) => setTimeout(done, 300));
  const reopened = await project(page);
  check(
    "reabre o arquivo com mídia, marcadores e edições",
    JSON.stringify(reopened.tracks) === JSON.stringify(beforeFile.tracks) &&
      reopened.markers.length === 1 &&
      Object.values(reopened.materials).every((material) => !material.offline),
    `${(packed.length * 0.75 / 1024).toFixed(0)} KB`,
  );
  await seek(page, 3);
  await new Promise((done) => setTimeout(done, 500));
  const reopenedPixel = await previewPixel(20, 20);
  check("mídia do arquivo aparece no preview", reopenedPixel[0] > 200 && reopenedPixel[1] < 60, reopenedPixel.join(","));

  await clickButton(page, "Novo");
  await page.waitForFunction(() => window.__retalho.getState().project.tracks.length === 0);
  await fileInput.uploadFile(paths.video, paths.split);
  await page.waitForFunction(
    () => Object.keys(window.__retalho.getState().project.materials).length === 2,
    { timeout: 20000 },
  );
  await clickBinItem(page, 0);
  await page.waitForSelector(".clip");
  await page.select('[data-testid="canvas-preset"]', "9:16");
  await seek(page, 0.5);
  await deselect(page);
  await page.waitForSelector('[data-testid="bg-kind"]');
  await settle();
  const blackBar = await previewPixel(360, 30);
  await choose(page, "bg-kind", "color");
  await page.waitForSelector('[data-testid="bg-color"]');
  await setInput(page, '[data-testid="bg-color"]', "#00ff00");
  await settle();
  const colorBar = await previewPixel(360, 30);
  check(
    "fundo em cor preenche as faixas do vídeo",
    blackBar[1] < 30 && colorBar[1] > 200 && colorBar[0] < 60,
    `${blackBar.join(",")} / ${colorBar.join(",")}`,
  );
  await choose(page, "bg-kind", "blur");
  await settle();
  const blurBar = await previewPixel(360, 30);
  check("fundo desfocado usa o próprio vídeo", blurBar[0] > 200 && blurBar[1] < 60, blurBar.join(","));
  const verticalUrl = await runExport(page, { format: "png" });
  const vertical = await imageInfo(page, verticalUrl, 540, 45);
  await page.click('[data-testid="export-close"]');
  check(
    "fundo desfocado sai igual no arquivo 9:16",
    vertical.width === 1080 && vertical.height === 1920 && vertical.pixel[0] > 200 && vertical.pixel[1] < 60,
    `${vertical.width}x${vertical.height} ${vertical.pixel.join(",")}`,
  );
  await choose(page, "bg-kind", "");
  await page.select('[data-testid="canvas-preset"]', "16:9");

  await clickBinItem(page, 1);
  await settle();
  await openSection(page, "cut", "crop");
  await setInput(page, 'input[aria-label="Esquerda, valor"]', "50");
  await settle();
  const croppedCenter = await previewPixel(640, 360);
  const croppedSide = await previewPixel(20, 360);
  check(
    "recorte mostra só a metade escolhida e reencaixa",
    croppedCenter[0] > 200 && croppedCenter[1] > 200 && croppedSide[0] > 200 && croppedSide[1] < 60,
    `${croppedCenter.join(",")} / ${croppedSide.join(",")}`,
  );
  await setInput(page, 'input[aria-label="Esquerda, valor"]', "0");

  await openSection(page, "cut", "mask");
  await choose(page, "mask-shape", "circle");
  await settle();
  const insideMask = await previewPixel(500, 360);
  const outsideMask = await previewPixel(20, 20);
  check(
    "máscara mostra a imagem dentro e o vídeo de baixo fora",
    insideMask[2] > 200 && insideMask[0] < 60 && outsideMask[0] > 200 && outsideMask[2] < 60,
    `${insideMask.join(",")} / ${outsideMask.join(",")}`,
  );
  await page.click('[data-testid="mask-invert"]');
  await settle();
  const insideInverted = await previewPixel(500, 360);
  const outsideInverted = await previewPixel(20, 20);
  check(
    "inverter troca dentro e fora",
    insideInverted[0] > 200 && insideInverted[2] < 60 && outsideInverted[2] > 200 && outsideInverted[0] < 60,
    `${insideInverted.join(",")} / ${outsideInverted.join(",")}`,
  );
  await page.click('[data-testid="mask-invert"]');
  await choose(page, "mask-shape", "linear");
  await setInput(page, 'input[aria-label="Suavizar, valor"]', "0.2");
  await settle();
  const softPreview = await previewPixel(100, 330);
  const softUrl = await runExport(page, { format: "png" });
  const softFile = await imageInfo(page, softUrl, 150, 495);
  await page.click('[data-testid="export-close"]');
  check(
    "borda suave fica igual no preview e no arquivo",
    softPreview[2] > 20 && softPreview[2] < 235 && Math.abs(softPreview[2] - softFile.pixel[2]) < 20,
    `preview ${softPreview.join(",")} arquivo ${softFile.pixel.join(",")}`,
  );
  await choose(page, "mask-shape", "");

  await page.click('[data-testid="add-text"]');
  await openPanel(page, "presets");
  await page.waitForSelector('[data-testid="preset-maquina"]');
  await page.click('[data-testid="preset-maquina"]');
  const white = "r>230&&g>230&&b>230";
  await settle();
  const typedNone = (await countPixels(page, white)).count;
  await seek(page, 1);
  await settle();
  const typedHalf = (await countPixels(page, white)).count;
  await seek(page, 2);
  await settle();
  const typedAll = (await countPixels(page, white)).count;
  check(
    "modelo com digitação revela o texto aos poucos",
    typedNone === 0 && typedHalf > 100 && typedAll > typedHalf * 1.4,
    `${typedNone} ${typedHalf} ${typedAll}`,
  );

  await page.click('[data-testid="preset-legenda"]');
  await openPanel(page, "style");
  await page.click('[data-testid="text-shadow"]');
  await page.waitForSelector('input[aria-label="Cor da sombra"]');
  await setInput(page, 'input[aria-label="Cor da sombra"]', "#00ff00");
  await setInput(page, 'input[aria-label="Desfoque, valor"]', "0");
  await setInput(page, 'input[aria-label="Distância, valor"]', "30");
  await settle();
  const shadowPixels = (await countPixels(page, "g>200&&r<80&&b<80")).count;
  check("sombra do texto aparece", shadowPixels > 200, `${shadowPixels} pixels`);

  const flat = await countPixels(page, white);
  await openPanel(page, "text");
  await setInput(page, 'input[aria-label="Curvatura, valor"]', "120");
  await settle();
  const curved = await countPixels(page, white);
  check(
    "texto curvo ocupa mais altura",
    curved.bottom - curved.top > (flat.bottom - flat.top) * 1.5,
    `${flat.bottom - flat.top}px para ${curved.bottom - curved.top}px`,
  );

  await openPanel(page, "position");
  await page.click('[aria-label="Keyframe de Posição X"]');
  await openSection(page, "animate", "motion");
  await page.waitForSelector('[data-testid="easing"]');
  await choose(page, "easing", "inOut");
  const eased = (await project(page)).tracks.find((track) => track.type === "text").segments[0].keyframes.x[0].ease;
  check("aplica suavização nos keyframes", eased === "inOut", eased);

  await openPanel(page, "presets");
  const presetCount = (await page.$$(".preset")).length;
  await page.click('[data-testid="preset-save"]');
  check("salva um estilo próprio", (await page.$$(".preset")).length === presetCount + 1);

  await page.click('[data-testid="track-lock"]');
  const locked = await page.$eval("fieldset.inspector-body", (element) => element.disabled);
  await page.click('[data-testid="track-lock"]');
  check("faixa bloqueada desativa o painel inteiro", locked === true);
  await page.screenshot({ path: join(OUT, "grupo2.png") });

  const imageClip = (await project(page)).tracks.find((track) => track.segments.some((s) => s.target.start > 0 && s.target.duration === 5_000_000 && track.type === "video"));
  await page.click(`[data-segment-id="${imageClip.segments[0].id}"]`);
  await openSection(page, "cut", "mask");
  await choose(page, "mask-shape", "circle");
  await openSection(page, "animate", "clip-anim");
  await choose(page, "animIn", "fade");
  await settle();
  await page.screenshot({ path: join(OUT, "painel-video.png") });
  const exportButton = await page.$eval('[data-testid="export-open"]', (element) => getComputedStyle(element).backgroundColor);
  check("botão Exportar continua em destaque", exportButton === "rgb(242, 163, 58)", exportButton);
  const pagesThatScroll = async () => {
    const overflow = [];
    for (const tab of await page.$$eval(".rail-item", (items) => items.map((item) => item.dataset.testid))) {
      await page.click(`[data-testid="${tab}"]`);
      const sections = await page.$$eval(".panel .subtab", (items) => items.map((item) => item.dataset.testid));
      for (const section of sections.length ? sections : [null]) {
        if (section) await page.click(`[data-testid="${section}"]`);
        const fits = await page.$eval(".inspector-body", (element) => element.scrollHeight <= element.clientHeight + 1);
        if (!fits) overflow.push(section ?? tab);
      }
    }
    const railFits = await page.$eval(".rail", (element) => element.scrollHeight <= element.clientHeight + 1);
    return railFits ? overflow : [...overflow, "rail"];
  };
  const textClip = (await project(page)).tracks.find((track) => track.type === "text").segments[0].id;
  for (const [width, height] of [[1440, 900], [1366, 768]]) {
    await page.setViewport({ width, height });
    await settle();
    await page.click(`[data-segment-id="${imageClip.segments[0].id}"]`);
    const media = await pagesThatScroll();
    await page.click(`[data-segment-id="${textClip}"]`);
    const text = await pagesThatScroll();
    check(`nenhuma categoria precisa de rolagem em ${width}x${height}`, media.length + text.length === 0, [...media, ...text].join(" "));
  }
  await page.screenshot({ path: join(OUT, "notebook.png") });
  await page.setViewport({ width: 1440, height: 900 });
  await deselect(page);
  await settle();
  await page.screenshot({ path: join(OUT, "painel-projeto.png") });
  const maskedUrl = await runExport(page, { resolution: "720" });
  const maskedVideo = await saveDownload(page, maskedUrl, "saida-mascara.mp4");
  await page.click('[data-testid="export-close"]');
  if (FFMPEG) {
    const inside = ffmpegPixel(maskedVideo, 3, 25, 18);
    const outside = ffmpegPixel(maskedVideo, 3, 1, 1);
    check(
      "ffmpeg vê a máscara no MP4 exportado",
      inside[2] > 180 && inside[0] < 80 && outside[1] > 180 && outside[2] < 80,
      `${inside.join(",")} / ${outside.join(",")}`,
    );
    const fading = ffmpegPixel(maskedVideo, 0.55, 25, 18);
    const settled = ffmpegPixel(maskedVideo, 1.2, 25, 18);
    check(
      "ffmpeg vê a animação de entrada acontecendo",
      fading[2] < settled[2] - 40,
      `${fading.join(",")} para ${settled.join(",")}`,
    );
  }

  await clickButton(page, "Novo");
  await page.waitForFunction(() => window.__retalho.getState().project.tracks.length === 0);
  const toneMs = wavFile(4, 440);
  const tonePath = join(OUT, "tom4.wav");
  writeFileSync(tonePath, toneMs);
  const beatPath = join(OUT, "batidas.wav");
  writeFileSync(beatPath, clickTrack(12, 120));
  const noisyPath = join(OUT, "ruido.wav");
  writeFileSync(noisyPath, noisyTone(4));
  await fileInput.uploadFile(tonePath, beatPath, noisyPath);
  await page.waitForFunction(
    () => Object.keys(window.__retalho.getState().project.materials).length === 3,
    { timeout: 20000 },
  );
  const audioBusyEnds = () => page.waitForFunction(() => window.__retalho.getState().audioBusy === 0, { timeout: 30000 });
  const decodeWav = (href, body) =>
    page.evaluate(
      async (url, source) => {
        const decoded = await new OfflineAudioContext(2, 1, 48000).decodeAudioData(await (await (await fetch(url)).blob()).arrayBuffer());
        return new Function("decoded", source)(decoded);
      },
      href,
      body,
    );
  const FREQUENCY = `
    const samples = decoded.getChannelData(0);
    const from = Math.floor(samples.length * 0.2);
    const to = Math.floor(samples.length * 0.8);
    let crossings = 0;
    for (let index = from + 1; index < to; index += 1) if (samples[index - 1] < 0 && samples[index] >= 0) crossings += 1;
    return { frequency: crossings / ((to - from) / decoded.sampleRate), duration: decoded.duration };
  `;

  await clickBinItem(page, 0);
  await page.waitForSelector(".clip-audio");
  await page.click(".clip-audio");
  await openPanel(page, "speed");
  await choose(page, "speed", "2");
  await settle();
  await audioBusyEnds();
  const keptUrl = await runExport(page, { format: "wav" });
  const kept = await decodeWav(keptUrl, FREQUENCY);
  await page.click('[data-testid="export-close"]');
  check(
    "velocidade 2× mantém o tom no arquivo",
    Math.abs(kept.frequency - 440) < 6 && Math.abs(kept.duration - 2) < 0.05,
    `${kept.frequency.toFixed(1)} Hz em ${kept.duration.toFixed(2)}s`,
  );
  await page.click('[data-testid="keep-pitch"]');
  const tapeUrl = await runExport(page, { format: "wav" });
  const tape = await decodeWav(tapeUrl, FREQUENCY);
  await page.click('[data-testid="export-close"]');
  check("desligar mantém o efeito de fita", Math.abs(tape.frequency - 880) < 12, `${tape.frequency.toFixed(1)} Hz`);
  await page.click('[data-testid="keep-pitch"]');

  await openSection(page, "audio", "sound");
  await setInput(page, 'input[aria-label="Balanço, valor"]', "-1");
  const panUrl = await runExport(page, { format: "wav" });
  const panned = await decodeWav(panUrl, `
    const level = (channel) => {
      let sum = 0;
      for (const sample of decoded.getChannelData(channel)) sum += sample * sample;
      return Math.sqrt(sum / decoded.length);
    };
    return { left: level(0), right: level(1) };
  `);
  await page.click('[data-testid="export-close"]');
  check("balanço leva o som para um lado", panned.left > 0.1 && panned.right < 0.001, `L ${panned.left.toFixed(3)} R ${panned.right.toFixed(4)}`);
  await setInput(page, 'input[aria-label="Balanço, valor"]', "0");

  await openSection(page, "audio", "auto");
  await page.click('[data-testid="normalize-clip"]');
  await page.waitForFunction(() => window.__retalho.getState().project.tracks[0].segments[0].volume !== 1, { timeout: 15000 });
  const normalized = (await project(page)).tracks[0].segments[0].volume;
  check("normalizar ajusta o volume para -14 LUFS", normalized > 0.3 && normalized < 0.9, `volume ${normalized.toFixed(3)}`);

  await clickButton(page, "Excluir");
  await clickBinItem(page, 1);
  await page.waitForSelector(".clip-audio");
  await page.click(".clip-audio");
  await openSection(page, "audio", "auto");
  await page.click('[data-testid="mark-beats"]');
  await page.waitForSelector('[data-testid="beat"]', { timeout: 20000 });
  const marks = (await project(page)).tracks[0].segments[0].beats;
  const offBeat = Math.max(...marks.map((beat) => Math.abs(((beat / 1e6 - 0.3 + 0.25) % 0.5) - 0.25)));
  check(
    "marca as batidas de 120 BPM no clipe",
    marks.length >= 21 && marks.length <= 24 && offBeat < 0.03 && (await page.$$('[data-testid="beat"]')).length === marks.length,
    `${marks.length} batidas, erro máximo ${(offBeat * 1000).toFixed(0)} ms`,
  );

  await clickButton(page, "Excluir");
  await clickBinItem(page, 2);
  await page.waitForSelector(".clip-audio");
  await page.click(".clip-audio");
  await openSection(page, "audio", "sound");
  const quietPart = `
    const samples = decoded.getChannelData(0);
    let sum = 0;
    const end = Math.floor(decoded.sampleRate * 0.75);
    for (let index = Math.floor(decoded.sampleRate * 0.25); index < end; index += 1) sum += samples[index] * samples[index];
    let loud = 0;
    for (let index = decoded.sampleRate * 2; index < decoded.sampleRate * 3; index += 1) loud += samples[index] * samples[index];
    return { noise: Math.sqrt(sum / (end - decoded.sampleRate * 0.25)), tone: Math.sqrt(loud / decoded.sampleRate) };
  `;
  const rawUrl = await runExport(page, { format: "wav" });
  const raw = await decodeWav(rawUrl, quietPart);
  await page.click('[data-testid="export-close"]');
  await page.click('[data-testid="denoise"]');
  const cleanUrl = await runExport(page, { format: "wav" });
  const clean = await decodeWav(cleanUrl, quietPart);
  await page.click('[data-testid="export-close"]');
  const drop = 20 * Math.log10(clean.noise / raw.noise);
  const toneChange = 20 * Math.log10(clean.tone / raw.tone);
  check(
    "reduzir ruído limpa o arquivo e preserva o som",
    drop < -8 && Math.abs(toneChange) < 1.5,
    `ruído ${drop.toFixed(1)} dB, tom ${toneChange.toFixed(2)} dB`,
  );
  await settle();
  await page.screenshot({ path: join(OUT, "painel-audio.png") });

  await clickBinItem(page, 1);
  await seek(page, 8);
  await clickBinItem(page, 0);
  await settle();
  await page.click(".clip-audio");
  await openSection(page, "audio", "sound");
  await page.click('[data-testid="denoise"]');
  await page.click('[data-testid="denoise"]');
  for (const [width, height] of [[1440, 900], [1366, 768]]) {
    await page.setViewport({ width, height });
    await settle();
    const crowded = await pagesThatScroll();
    check(`categorias de áudio não rolam em ${width}x${height}`, crowded.length === 0, crowded.join(" "));
  }
  await page.setViewport({ width: 1440, height: 900 });

  await clickButton(page, "Novo");
  await page.waitForFunction(() => window.__retalho.getState().project.tracks.length === 0);
  await fileInput.uploadFile(paths.video, paths.split);
  await page.waitForFunction(
    () => Object.keys(window.__retalho.getState().project.materials).length === 2,
    { timeout: 20000 },
  );
  await clickBinItem(page, 0);
  await page.waitForSelector(".clip");
  await seek(page, 0.5);
  await clickBinItem(page, 1);
  await seek(page, 1);
  await settle();
  const setField = async (label, value) => {
    await setInput(page, `input[aria-label="${label}, valor"]`, String(value));
    await settle();
  };
  const near = (value, target, margin) => Math.abs(value - target) <= margin;

  await openSection(page, "color", "basic");
  await setField("Exposição", -100);
  const darker = await previewPixel(20, 360);
  check("exposição na GPU escurece dois stops", near(darker[2], 64, 10) && darker[0] < 10, darker.join(","));
  await setField("Exposição", 0);

  await setField("Brilho", -40);
  const direct = await previewPixel(20, 360);
  await openSection(page, "color", "detail");
  await setField("Nitidez", 100);
  const throughGpu = await previewPixel(20, 360);
  check(
    "caminho da GPU dá a mesma cor do caminho direto",
    throughGpu.slice(0, 3).every((channel, index) => near(channel, direct[index], 3)),
    `direto ${direct.join(",")} GPU ${throughGpu.join(",")}`,
  );
  await setField("Nitidez", 0);
  await openSection(page, "color", "basic");
  await setField("Brilho", 0);

  await openSection(page, "color", "light");
  await setField("Temperatura", 100);
  const warm = await previewPixel(1200, 360);
  const warmBlue = await previewPixel(20, 360);
  check("temperatura esquenta a imagem", warmBlue[2] < 215 && warm[0] > 240, `${warmBlue.join(",")} / ${warm.join(",")}`);
  await setField("Temperatura", 0);

  await openSection(page, "color", "detail");
  await setField("Vinheta", 100);
  const corner = await previewPixel(4, 4);
  const middle = await previewPixel(500, 360);
  check("vinheta escurece só os cantos", corner[2] < 90 && middle[2] > 230, `${corner.join(",")} / ${middle.join(",")}`);
  await setField("Vinheta", 0);

  await openSection(page, "color", "lut");
  const cubePath = join(OUT, "inverter.cube");
  writeFileSync(cubePath, invertCube());
  await (await page.$('[data-testid="lut-input"]')).uploadFile(cubePath);
  await page.waitForFunction(() => Object.keys(window.__retalho.getState().project.luts ?? {}).length === 1);
  await settle();
  const inverted = await previewPixel(20, 360);
  check("LUT .cube inverte as cores", inverted[0] > 240 && inverted[1] > 240 && inverted[2] < 15, inverted.join(","));
  await setField("Intensidade", 50);
  const halfway = await previewPixel(20, 360);
  check("intensidade do LUT mistura com o original", near(halfway[0], 128, 12) && near(halfway[2], 128, 12), halfway.join(","));
  await setField("Intensidade", 100);

  const lutFile = await page.evaluate(async () => {
    const saved = new Uint8Array(await window.__retalho.buildProjectFile().arrayBuffer());
    let binary = "";
    for (let index = 0; index < saved.length; index += 8192) {
      binary += String.fromCharCode(...saved.subarray(index, index + 8192));
    }
    return btoa(binary);
  });
  const lutProject = join(OUT, "com-lut.retalho");
  writeFileSync(lutProject, Buffer.from(lutFile, "base64"));
  await clickButton(page, "Novo");
  await page.waitForFunction(() => window.__retalho.getState().project.tracks.length === 0);
  await (await page.$('[data-testid="project-input"]')).uploadFile(lutProject);
  await page.waitForFunction(() => window.__retalho.getState().project.tracks.length > 0, { timeout: 20000 });
  await seek(page, 1);
  await settle();
  const fromFile = await previewPixel(20, 360);
  check("LUT volta com o arquivo .retalho", fromFile[0] > 240 && fromFile[2] < 15, fromFile.join(","));

  await settle();
  await settle();
  await page.reload();
  await page.waitForSelector(".clip");
  await seek(page, 1);
  await settle();
  const afterReload = await previewPixel(20, 360);
  check("LUT volta ao recarregar a página", afterReload[0] > 240 && afterReload[2] < 15, afterReload.join(","));

  const overlay = (await project(page)).tracks.find((track) => track.segments[0].target.duration === 5_000_000).segments[0].id;
  await page.click(`[data-segment-id="${overlay}"]`);
  await openSection(page, "color", "lut");
  await choose(page, "lut", "");

  await openSection(page, "cut", "chroma");
  await page.click('[data-testid="chroma"]');
  await page.waitForSelector('[data-testid="chroma-color"]');
  await setInput(page, '[data-testid="chroma-color"]', "#0000ff");
  await settle();
  const keyedOut = await previewPixel(20, 360);
  const keptIn = await previewPixel(1200, 360);
  check(
    "chroma remove a cor e mostra o vídeo de baixo",
    keyedOut[0] > 200 && keyedOut[2] < 60 && keptIn[0] > 200 && keptIn[1] > 200,
    `${keyedOut.join(",")} / ${keptIn.join(",")}`,
  );
  const keyedUrl = await runExport(page, { resolution: "720" });
  const keyedVideo = await saveDownload(page, keyedUrl, "saida-chroma.mp4");
  await page.click('[data-testid="export-close"]');
  if (FFMPEG) {
    const removed = ffmpegPixel(keyedVideo, 1, 8, 18);
    const remains = ffmpegPixel(keyedVideo, 1, 56, 18);
    check(
      "ffmpeg vê o chroma no MP4 exportado",
      removed[0] > 180 && removed[2] < 80 && remains[0] > 180 && remains[1] > 180,
      `${removed.join(",")} / ${remains.join(",")}`,
    );
  }
  await page.click('[data-testid="chroma"]');
  await settle();

  await openPanel(page, "effects");
  const digest = () =>
    page.evaluate(() => {
      const canvas = document.querySelector('[data-testid="preview"]');
      const { data } = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height);
      const values = [];
      for (let y = 8; y < canvas.height; y += 16) {
        for (let x = 8; x < canvas.width; x += 16) values.push(data[(y * canvas.width + x) * 4 + 2]);
      }
      // The test image is flat, so pixelating only shows along the line between its halves.
      for (let x = 620; x < 660; x += 1) values.push(data[(360 * canvas.width + x) * 4 + 2]);
      return values;
    });
  const plain = await digest();
  const changedBy = [];
  for (const effect of ["blur", "glow", "glitch", "pixelate", "shake", "retro"]) {
    await page.click(`[data-testid="effect-${effect}"]`);
    await settle();
    const after = await digest();
    if (after.some((value, index) => Math.abs(value - plain[index]) > 8)) changedBy.push(effect);
    await page.click(`[data-testid="effect-${effect}"]`);
    await settle();
  }
  check("cada efeito muda a imagem", changedBy.length === 6, changedBy.join(" "));

  await page.click('[data-testid="effect-blur"]');
  await settle();
  const softEdge = await previewPixel(636, 360);
  await page.click('[data-testid="effect-blur"]');
  check("desfoque mistura as duas metades", softEdge[0] > 40 && softEdge[0] < 220, softEdge.join(","));

  for (const effect of ["blur", "glow", "glitch", "pixelate", "shake", "retro"]) {
    await page.click(`[data-testid="effect-${effect}"]`);
  }
  await settle();
  await page.screenshot({ path: join(OUT, "painel-efeitos.png") });
  const videoClip = (await project(page)).tracks[0].segments[0].id;
  for (const [width, height] of [[1440, 900], [1366, 768]]) {
    await page.setViewport({ width, height });
    await settle();
    await page.click(`[data-segment-id="${overlay}"]`);
    const overlayPages = await pagesThatScroll();
    await page.click(`[data-segment-id="${videoClip}"]`);
    const videoPages = await pagesThatScroll();
    check(
      `todas as seções cabem sem rolagem em ${width}x${height}`,
      overlayPages.length + videoPages.length === 0,
      [...overlayPages, ...videoPages].join(" "),
    );
  }
  await page.setViewport({ width: 1440, height: 900 });
  await page.click(`[data-segment-id="${overlay}"]`);
  await openSection(page, "color", "light");
  await settle();
  await page.screenshot({ path: join(OUT, "painel-cor.png") });

  await clickButton(page, "Novo");
  await page.waitForFunction(() => window.__retalho.getState().project.tracks.length === 0);
  const pausedPath = join(OUT, "com-pausa.wav");
  writeFileSync(pausedPath, pausedTone());
  const sceneInput = await page.$('[data-testid="file-input"]');
  await sceneInput.uploadFile(paths.video, pausedPath);
  await page.waitForFunction(
    () => Object.keys(window.__retalho.getState().project.materials).length === 2,
    { timeout: 20000 },
  );
  await clickBinItem(page, 0);
  await page.waitForSelector(".clip-video");
  await page.click(".clip-video");
  await openSection(page, "cut", "crop");
  await page.click('[data-testid="split-scenes"]');
  await page.waitForFunction(() => window.__retalho.getState().project.tracks[0].segments.length === 2, { timeout: 30000 });
  const sceneAt = (await project(page)).tracks[0].segments[1].target.start;
  check("divide o vídeo na troca de cena", Math.abs(sceneAt - 2_000_000) <= 40_000, `${(sceneAt / 1e6).toFixed(3)}s`);
  await page.click('[aria-label="Fechar aviso"]');

  await clickButton(page, "Novo");
  await page.waitForFunction(() => window.__retalho.getState().project.tracks.length === 0);
  await (await page.$('[data-testid="file-input"]')).uploadFile(pausedPath);
  await page.waitForFunction(() => Object.keys(window.__retalho.getState().project.materials).length === 1, { timeout: 20000 });
  await clickBinItem(page, 0);
  await page.waitForSelector(".clip-audio");
  await page.click(".clip-audio");
  await openSection(page, "audio", "auto");
  await page.click('[data-testid="cut-pauses"]');
  await page.waitForFunction(() => window.__retalho.getState().project.tracks[0].segments.length === 2, { timeout: 15000 });
  const afterPause = (await project(page)).tracks[0].segments.at(-1);
  const pausedLength = (afterPause.target.start + afterPause.target.duration) / 1e6;
  check("corta a pausa e mantém o som", Math.abs(pausedLength - 2.16) < 0.06, `${pausedLength.toFixed(2)}s de 3s`);
  const measuredPause = (await project(page)).tracks.flatMap((track) => track.segments).find((item) => item.analise?.pausas)?.analise.pausas[0];
  check("grava o silêncio inteiro em analise.pausas", measuredPause && Math.abs((measuredPause.fim - measuredPause.inicio) / 1e6 - 1) < 0.06, JSON.stringify(measuredPause));
  await page.click('[aria-label="Fechar aviso"]');

  const speechFile = process.env.RETALHO_SPEECH_WAV;
  if (speechFile && existsSync(speechFile)) {
    await clickButton(page, "Novo");
    await page.waitForFunction(() => window.__retalho.getState().project.tracks.length === 0);
    await (await page.$('[data-testid="file-input"]')).uploadFile(speechFile);
    await page.waitForFunction(() => Object.keys(window.__retalho.getState().project.materials).length === 1, { timeout: 20000 });
    await clickBinItem(page, 0);
    await page.waitForSelector(".clip-audio");
    await page.click(".clip-audio");
    await openSection(page, "audio", "speech");
    await page.screenshot({ path: join(OUT, "fala-antes.png") });
    const speechStart = Date.now();
    await page.click('[data-testid="transcribe"]');
    await page.waitForFunction(
      () => (window.__retalho.getState().project.tracks[0].segments[0].words?.length ?? 0) > 20,
      { timeout: 300000 },
    );
    const spoken = (await project(page)).tracks[0].segments[0].words;
    const phrase = spoken.map((item) => item.text).join(" ").toLowerCase();
    const expected = ["bom dia", "redes sociais", "primeiro", "legendas", "sem som"];
    check(
      "transcreve a voz em português",
      expected.every((text) => phrase.includes(text)),
      `${spoken.length} palavras em ${((Date.now() - speechStart) / 1000).toFixed(1)}s`,
    );
    check("cada palavra tem tempo", spoken.every((item) => item.end > item.start) && spoken[0].start < 1_000_000, `primeira em ${(spoken[0].start / 1e6).toFixed(2)}s`);

    await page.waitForSelector('[data-testid="create-captions"]');
    await page.click('[data-testid="create-captions"]');
    await page.waitForFunction(() => window.__retalho.getState().project.tracks.some((track) => track.name === "Legendas"));
    await page.click('[aria-label="Fechar aviso"]');
    const captionsBefore = (await project(page)).tracks.find((track) => track.name === "Legendas").segments;
    check(
      "cria legendas no tempo da fala",
      captionsBefore.length >= 4 && captionsBefore[0].target.start < 1_000_000,
      `${captionsBefore.length} legendas`,
    );

    await page.click(".clip-audio");
    await page.click('[data-testid="bin-transcript"]');
    await page.waitForSelector('[data-testid="word"]');
    const shown = (await page.$$('[data-testid="word"]')).length;
    check("mostra a transcrição no painel", shown === spoken.length, `${shown} palavras`);
    await settle();
    await page.screenshot({ path: join(OUT, "transcricao.png") });

    const lengthBefore = (await project(page)).tracks[0].segments.at(-1);
    const words = await page.$$('[data-testid="word"]');
    await words[2].click();
    await page.keyboard.down("Shift");
    await words[5].click();
    await page.keyboard.up("Shift");
    await page.click('[data-testid="transcript-delete"]');
    await settle();
    const edited = await project(page);
    const editedAudio = edited.tracks.find((track) => track.type === "audio");
    const lastClip = editedAudio.segments.at(-1);
    const removed = (lengthBefore.target.start + lengthBefore.target.duration - lastClip.target.start - lastClip.target.duration) / 1e6;
    const legend = edited.tracks.find((track) => track.name === "Legendas").segments;
    const shift = (captionsBefore.at(-1).target.start - legend.at(-1).target.start) / 1e6;
    check(
      "apagar palavras corta o vídeo e move as legendas junto",
      editedAudio.segments.length === 2 && removed > 0.3 && Math.abs(removed - shift) < 0.05,
      `${removed.toFixed(2)}s cortados, legendas ${shift.toFixed(2)}s`,
    );
    await page.click('[data-testid="sub-speech"]').catch(() => undefined);
    for (const [width, height] of [[1440, 900], [1366, 768]]) {
      await page.setViewport({ width, height });
      await settle();
      await page.click(".clip-audio");
      const crowded = await pagesThatScroll();
      check(`seções de fala não rolam em ${width}x${height}`, crowded.length === 0, crowded.join(" "));
    }
    await page.setViewport({ width: 1440, height: 900 });
    await clickButton(page, "Mídia");
  }

  await page.evaluate(async () => {
    (await import("/src/engine/media.ts")).pool.forceStreaming = true;
  });
  await clickButton(page, "Novo");
  await page.waitForFunction(() => window.__retalho.getState().project.tracks.length === 0);
  const longTonePath = join(OUT, "tom-longo.wav");
  writeFileSync(longTonePath, wavFile(65, 440));
  await (await page.$('[data-testid="file-input"]')).uploadFile(longTonePath);
  await page.waitForFunction(() => Object.keys(window.__retalho.getState().project.materials).length === 1, { timeout: 30000 });
  const streamedInfo = await page.evaluate(async () => {
    const { pool } = await import("/src/engine/media.ts");
    const [material] = Object.values(window.__retalho.getState().project.materials);
    return { streamed: pool.isStreamed(material.id), whole: Boolean(pool.audioBuffer(material.id)), hasAudio: material.hasAudio, duration: material.duration };
  });
  check(
    "áudio longo fica no disco, não na memória",
    streamedInfo.streamed && !streamedInfo.whole && streamedInfo.hasAudio && Math.abs(streamedInfo.duration - 65e6) < 1e5,
    JSON.stringify(streamedInfo),
  );
  await page.waitForFunction(
    async () => {
      const { pool } = await import("/src/engine/media.ts");
      const [material] = Object.values(window.__retalho.getState().project.materials);
      return Boolean(pool.waveform(material.id));
    },
    { timeout: 30000 },
  );
  check("forma de onda sai lendo o arquivo em partes", true);

  await clickBinItem(page, 0);
  await page.waitForSelector(".clip-audio");
  const seamUrl = await runExport(page, { format: "wav" });
  const seams = await decodeWav(seamUrl, `
    const samples = decoded.getChannelData(0);
    let jump = 0;
    let where = 0;
    for (let index = 1; index < samples.length - 48000; index += 1) {
      const step = Math.abs(samples[index] - samples[index - 1]);
      if (step > jump) { jump = step; where = index / decoded.sampleRate; }
    }
    let crossings = 0;
    for (let index = 1; index < samples.length; index += 1) if (samples[index - 1] < 0 && samples[index] >= 0) crossings += 1;
    return { jump, where, frequency: crossings / decoded.duration, duration: decoded.duration };
  `);
  await page.click('[data-testid="export-close"]');
  check(
    "emendas entre janelas de áudio não fazem clique",
    seams.jump < 0.04 && Math.abs(seams.frequency - 440) < 2 && Math.abs(seams.duration - 65) < 0.1,
    `maior salto ${seams.jump.toFixed(4)} em ${seams.where.toFixed(2)}s, ${seams.frequency.toFixed(1)} Hz`,
  );

  await seek(page, 8.5);
  const live = await page.evaluate(async () => {
    const { player } = await import("/src/ui/store.ts");
    player.play();
    await new Promise((done) => setTimeout(done, 200));
    const context = player.audioContext;
    const analyser = context.createAnalyser();
    player.master.connect(analyser);
    const samples = new Float32Array(2048);
    const levels = [];
    for (let index = 0; index < 28; index += 1) {
      await new Promise((done) => setTimeout(done, 100));
      analyser.getFloatTimeDomainData(samples);
      levels.push(Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length));
    }
    player.pause();
    return { lowest: Math.min(...levels.slice(3)), highest: Math.max(...levels) };
  });
  check(
    "reprodução ao vivo atravessa a janela sem silêncio",
    live.lowest > 0.15,
    `nível de ${live.lowest.toFixed(3)} a ${live.highest.toFixed(3)}`,
  );

  await page.click(".clip-audio");
  await openPanel(page, "speed");
  await choose(page, "speed", "2");
  await settle();
  await audioBusyEnds();
  const streamedFast = await runExport(page, { format: "wav" });
  const fastTone = await decodeWav(streamedFast, FREQUENCY);
  await page.click('[data-testid="export-close"]');
  check("manter o tom funciona com áudio em partes", Math.abs(fastTone.frequency - 440) < 6, `${fastTone.frequency.toFixed(1)} Hz`);

  await clickButton(page, "Novo");
  await page.waitForFunction(() => window.__retalho.getState().project.tracks.length === 0);
  await (await page.$('[data-testid="file-input"]')).uploadFile(paths.video);
  await page.waitForFunction(() => Object.keys(window.__retalho.getState().project.materials).length === 1, { timeout: 30000 });
  await clickBinItem(page, 0);
  await page.waitForSelector(".clip-video");
  const streamedVideoUrl = await runExport(page, { resolution: "720" });
  const streamedVideo = await saveDownload(page, streamedVideoUrl, "saida-partes.mp4");
  await page.click('[data-testid="export-close"]');
  if (FFMPEG) {
    const info = spawnSync(FFMPEG, ["-hide_banner", "-i", streamedVideo], { encoding: "utf8" }).stderr;
    check("MP4 com áudio em partes tem imagem e som", /Video: h264/.test(info) && /Audio: aac/.test(info), /Duration: [\d:.]+/.exec(info)?.[0]);
  }
  await page.evaluate(async () => {
    (await import("/src/engine/media.ts")).pool.forceStreaming = false;
  });

  const fullVideoPath = join(OUT, "saida.mp4");
  await clickButton(page, "Novo");
  await page.waitForFunction(() => window.__retalho.getState().project.tracks.length === 0);
  await (await page.$('[data-testid="file-input"]')).uploadFile(fullVideoPath);
  await page.waitForFunction(() => Object.keys(window.__retalho.getState().project.materials).length === 1, { timeout: 30000 });
  await clickBinItem(page, 0);
  await page.waitForSelector(".clip-video");
  await seek(page, 1);
  await settle();
  const fullPixel = await previewPixel(30, 30);
  const previewSource = () =>
    page.evaluate(async () => {
      const { pool } = await import("/src/engine/media.ts");
      const { project } = window.__retalho.getState();
      const segment = project.tracks[0].segments[0];
      const video = pool.videoFor(segment.id, project.materials[segment.materialId]);
      if (!video.videoWidth) await new Promise((done) => video.addEventListener("loadeddata", done, { once: true }));
      return video.videoHeight;
    });
  check("preview começa no vídeo original", (await previewSource()) === 1080);

  await page.click('[data-testid="light-preview"]');
  await page.waitForFunction(() => window.__retalho.getState().lightPreview && !window.__retalho.getState().task, { timeout: 120000 });
  await settle();
  const lightHeight = await previewSource();
  const lightPixel = await previewPixel(30, 30);
  check(
    "preview leve usa a cópia de 540p com a mesma imagem",
    lightHeight === 540 && lightPixel.slice(0, 3).every((channel, index) => near(channel, fullPixel[index], 14)),
    `${lightHeight}p ${lightPixel.join(",")} / ${fullPixel.join(",")}`,
  );

  await page.click('[data-testid="play"]');
  await new Promise((done) => setTimeout(done, 1000));
  await page.click('[data-testid="play"]');
  await settle();

  const proxyExport = await runExport(page, {});
  const proxyExportPath = await saveDownload(page, proxyExport, "saida-do-proxy.mp4");
  await page.click('[data-testid="export-close"]');
  const usedDuringExport = await page.evaluate(async () => {
    const { pool } = await import("/src/engine/media.ts");
    const { exportStill } = await import("/src/engine/exporter.ts");
    const { project } = window.__retalho.getState();
    const segment = project.tracks[0].segments[0];
    const heights = [];
    const original = pool.videoFor.bind(pool);
    pool.videoFor = (...args) => {
      const video = original(...args);
      heights.push(video.videoHeight);
      return video;
    };
    await exportStill(project, 3_000_000);
    pool.videoFor = original;
    return { heights: [...new Set(heights)].filter(Boolean), after: pool.videoFor(segment.id, project.materials[segment.materialId]).videoHeight };
  });
  check(
    "exportação lê o original mesmo com o preview leve ligado",
    usedDuringExport.heights.length === 1 && usedDuringExport.heights[0] === 1080 && usedDuringExport.after === 540,
    JSON.stringify(usedDuringExport),
  );
  if (FFMPEG) {
    const info = spawnSync(FFMPEG, ["-hide_banner", "-i", proxyExportPath], { encoding: "utf8" }).stderr;
    check("MP4 sai em 1920x1080 com o preview leve", /1920x1080/.test(info), /Video:.*/.exec(info)?.[0].slice(0, 70));
  }

  await page.click('[data-testid="light-preview"]');
  await page.waitForFunction(() => !window.__retalho.getState().lightPreview);
  await settle();
  check("desligar volta ao original", (await previewSource()) === 1080);
  await page.click('[data-testid="light-preview"]');
  await page.waitForFunction(() => window.__retalho.getState().lightPreview && !window.__retalho.getState().task, { timeout: 30000 });
  await clickButton(page, "Novo");
  await page.waitForFunction(() => window.__retalho.getState().project.tracks.length === 0);
  await settle();
  const leftovers = await page.evaluate(async () => {
    const folder = await navigator.storage.getDirectory();
    const names = [];
    for await (const name of folder.keys()) if (name.startsWith("proxy-")) names.push(name);
    return names.length;
  });
  check("Novo apaga as cópias leves do disco", leftovers === 0, `${leftovers} restantes`);

  await clickButton(page, "Novo");
  await page.waitForFunction(() => window.__retalho.getState().project.tracks.length === 0);
  {
  await page.click('[data-testid="bin-elements"]');
  await page.click('[data-testid="element-rectangle"]');
  await page.waitForSelector('[data-testid="shape-kind"]');
  await seek(page, 1);
  await settle();
  const amber = await previewPixel(640, 360);
  const outside = await previewPixel(20, 20);
  check("forma aparece no centro", near(amber[0], 242, 6) && near(amber[2], 58, 6) && outside[0] < 10, `${amber.join(",")} / ${outside.join(",")}`);
  await page.click('[data-testid="shape-gradient"]');
  await settle();
  const topColor = await previewPixel(640, 230);
  const bottomColor = await previewPixel(640, 490);
  check("gradiente vai de uma cor à outra", Math.abs(topColor[0] - bottomColor[0]) > 60, `${topColor.join(",")} / ${bottomColor.join(",")}`);
  await page.click('[data-testid="shape-kind-circle"]');
  await settle();
  const corner = await previewPixel(470, 200);
  check("círculo não preenche o canto da caixa", corner[0] < 10, corner.join(","));

  await page.click('[data-testid="shape-stroke"]');
  await openSection(page, "animate", "clip-anim");
  await choose(page, "animIn", "draw");
  await setField("Duração (s)", 2);
  await seek(page, 0.25);
  await settle();
  const white = "r>230&&g>230&&b>230";
  const earlyStroke = (await countPixels(page, white)).count;
  await seek(page, 3);
  await settle();
  const fullStroke = (await countPixels(page, white)).count;
  check("entrada Desenhar traça o contorno aos poucos", fullStroke > earlyStroke * 2 && fullStroke > 500, `${earlyStroke} para ${fullStroke} pixels`);

  await seek(page, 0);
  await page.click('[data-testid="element-text"]');
  await openSection(page, "animate", "letters");
  await choose(page, "letters", "rise");
  await seek(page, 0.2);
  await settle();
  const fewLetters = (await countPixels(page, white)).count;
  await seek(page, 2.5);
  await settle();
  const allLetters = (await countPixels(page, white)).count;
  check("letras entram uma a uma", allLetters > fewLetters * 1.3, `${fewLetters} para ${allLetters} pixels`);

  await clickButton(page, "Novo");
  await page.waitForFunction(() => window.__retalho.getState().project.tracks.length === 0);
  await page.evaluate(async () => {
    const { addSubtitles } = await import("/src/core/subtitles.ts");
    const store = await import("/src/ui/store.ts");
    store.edit((project) =>
      addSubtitles(project, [
        {
          start: 0,
          end: 3_000_000,
          text: "BOM DIA",
          words: [
            { text: "BOM", start: 0, end: 1_000_000 },
            { text: "DIA", start: 1_500_000, end: 3_000_000 },
          ],
        },
      ]),
    );
  });
  await page.waitForSelector(".clip-text");
  await page.click(".clip-text");
  await openSection(page, "style", "caption");
  await choose(page, "spoken", "highlight");
  
  await page.waitForSelector('[data-testid="spoken-color"]');
  await setInput(page, '[data-testid="spoken-color"]', "#00ff00");
  const greenWhere = async (seconds) => {
    await seek(page, seconds);
    await settle();
    return page.evaluate(() => {
      const canvas = document.querySelector('[data-testid="preview"]');
      const { data } = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height);
      let sum = 0;
      let count = 0;
      for (let index = 0; index < data.length; index += 4) {
        if (data[index + 1] > 200 && data[index] < 80 && data[index + 2] < 80) {
          sum += (index / 4) % canvas.width;
          count += 1;
        }
      }
      return { count, x: count ? sum / count : 0 };
    });
  };
  const firstWord = await greenWhere(0.5);
  const secondWord = await greenWhere(2);
  check(
    "karaokê destaca a palavra que está sendo falada",
    firstWord.count > 100 && secondWord.count > 100 && secondWord.x > firstWord.x + 40,
    `x ${firstWord.x.toFixed(0)} para ${secondWord.x.toFixed(0)}`,
  );
  await choose(page, "spoken", "single");
  const alone = await greenWhere(2);
  check("uma palavra por vez mostra só a palavra falada", alone.count > 100 && Math.abs(alone.x - 640) < 40, `x ${alone.x.toFixed(0)}`);

  await clickButton(page, "Novo");
  await page.waitForFunction(() => window.__retalho.getState().project.tracks.length === 0);
  await page.click('[data-testid="bin-elements"]').catch(() => undefined);
  await page.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.textContent === "Mídia").click());
  await (await page.$('[data-testid="file-input"]')).uploadFile(paths.split);
  await page.waitForFunction(() => Object.keys(window.__retalho.getState().project.materials).length === 1, { timeout: 20000 });
  await clickBinItem(page, 0);
  await page.waitForSelector(".clip-video");
  await openSection(page, "animate", "motion");
  await page.click('[data-testid="motion-panLeft"]');
  const edgeAt = async (seconds) => {
    await seek(page, seconds);
    await settle();
    return page.evaluate(() => {
      const canvas = document.querySelector('[data-testid="preview"]');
      const { data } = canvas.getContext("2d").getImageData(0, 360, canvas.width, 1);
      for (let x = 0; x < canvas.width; x += 1) if (data[x * 4] > 128) return x;
      return -1;
    });
  };
  const edgeStart = await edgeAt(0.1);
  const edgeEnd = await edgeAt(4.9);
  check("panorâmica move a imagem sem mostrar a borda", edgeStart > edgeEnd + 100 && (await previewPixel(2, 360))[2] > 200, `divisa de ${edgeStart} para ${edgeEnd}`);
  await page.waitForSelector('[data-testid="easing"]');
  await choose(page, "easing", "bounce");
  check("curva quicar aparece no painel", (await project(page)).tracks[0].segments[0].keyframes.x[0].ease === "bounce");
  check("timeline mostra os keyframes no clipe", (await page.$$(".clip-keyframe")).length >= 2);

  await clickButton(page, "Novo");
  await page.waitForFunction(() => window.__retalho.getState().project.tracks.length === 0);
  await page.click('[data-testid="bin-elements"]');
  await page.click('[data-testid="element-star"]');
  await page.waitForSelector('[data-testid="shape-kind"]');
  await page.click('[data-testid="shape-gradient"]');
  await page.click('[data-testid="shape-stroke"]');
  const shapeUrl = await runExport(page, { resolution: "720" });
  const shapeVideo = await saveDownload(page, shapeUrl, "saida-forma.mp4");
  await page.click('[data-testid="export-close"]');
  if (FFMPEG) {
    const center = ffmpegPixel(shapeVideo, 1, 32, 18);
    const away = ffmpegPixel(shapeVideo, 1, 2, 2);
    check("ffmpeg vê a forma no MP4", center[0] + center[1] + center[2] > 150 && away[0] < 30, `${center.join(",")} / ${away.join(",")}`);
  }
  for (const [width, height] of [[1440, 900], [1366, 768]]) {
    await page.setViewport({ width, height });
    await settle();
    await page.click(".clip-text");
    const shapePages = await pagesThatScroll();
    check(`páginas de forma não rolam em ${width}x${height}`, shapePages.length === 0, shapePages.join(" "));
  }
  await page.setViewport({ width: 1440, height: 900 });
  await page.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.textContent === "Mídia").click());
  await settle();
  await page.screenshot({ path: join(OUT, "movimento.png") });
  }

  {
    await clickButton(page, "Novo");
    await page.waitForFunction(() => window.__retalho.getState().project.tracks.length === 0);
    await (await page.$('[data-testid="file-input"]')).uploadFile(paths.video, paths.split);
    await page.waitForFunction(() => Object.keys(window.__retalho.getState().project.materials).length === 2, { timeout: 20000 });
    await clickBinItem(page, 0);
    await page.waitForSelector(".clip-video");
    await page.click(".clip-video");
    await seek(page, 1);
    await settle();
    const forward = await previewPixel(30, 30);
    await openPanel(page, "speed");
    await page.click('[data-testid="reverse"]');
    await settle();
    const backward = await previewPixel(30, 30);
    check("inverter mostra o fim do vídeo no começo", forward[0] > 200 && backward[1] > 200 && backward[0] < 60, `${forward.join(",")} / ${backward.join(",")}`);
    await audioBusyEnds();
    const reversedUrl = await runExport(page, { format: "wav" });
    const reversedAudio = await decodeWav(reversedUrl, FREQUENCY);
    await page.click('[data-testid="export-close"]');
    check("áudio invertido mantém a duração", Math.abs(reversedAudio.duration - 4) < 0.1, `${reversedAudio.duration.toFixed(2)}s`);
    await page.click('[data-testid="reverse"]');

    await seek(page, 1);
    await page.click('[data-testid="add-marker"]');
    await seek(page, 3);
    await page.click('[data-testid="add-marker"]');
    const partUrl = await runExport(page, { format: "wav", stretch: "markers" });
    const part = await decodeWav(partUrl, FREQUENCY);
    await page.click('[data-testid="export-close"]');
    check("exporta só o trecho entre marcadores", Math.abs(part.duration - 2) < 0.1, `${part.duration.toFixed(2)}s`);

    await seek(page, 0.5);
    await clickBinItem(page, 1);
    await settle();
    await openSection(page, "color", "hsl");
    await page.click('[data-testid="hsl-blue"]');
    await setField("Matiz", 100);
    const shiftedBlue = await previewPixel(20, 360);
    const keptYellow = await previewPixel(1200, 360);
    check(
      "HSL muda só a cor escolhida",
      (shiftedBlue[0] > 40 || shiftedBlue[1] > 40) && keptYellow[0] > 240 && keptYellow[1] > 240 && keptYellow[2] < 30,
      `${shiftedBlue.join(",")} / ${keptYellow.join(",")}`,
    );
    await setField("Matiz", 0);

    await openSection(page, "color", "curves");
    const curve = await (await page.$('[data-testid="curve"]')).boundingBox();
    await page.mouse.click(curve.x + curve.width / 2, curve.y + curve.height * 0.2);
    await settle();
    const overlayId = (await project(page)).tracks.find((track) => track.segments[0].target.duration === 5_000_000).segments[0].id;
    const points = (await project(page)).tracks.flatMap((track) => track.segments).find((item) => item.id === overlayId).curves?.master;
    check("clicar na curva adiciona um ponto", points?.length === 3, JSON.stringify(points));
    await page.evaluate(async (id) => {
      const ops = await import("/src/core/ops.ts");
      const store = await import("/src/ui/store.ts");
      store.edit((value) =>
        ops.updateSegment(value, id, (segment) => {
          segment.curves = { master: [[0, 1], [1, 0]] };
        }),
      );
    }, overlayId);
    await settle();
    const invertedByCurve = await previewPixel(20, 360);
    check("curva inverte as cores no preview", invertedByCurve[0] > 240 && invertedByCurve[2] < 15, invertedByCurve.join(","));

    const fontPath = join(OUT, "MinhaFonte.ttf");
    copyFileSync("C:/Windows/Fonts/georgia.ttf", fontPath);
    await page.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.textContent === "Mídia").click());
    await (await page.$('[data-testid="file-input"]')).uploadFile(fontPath);
    await page.waitForFunction(() => Object.keys(window.__retalho.getState().project.fonts ?? {}).length === 1, { timeout: 15000 });
    const fontLoaded = await page.evaluate(() => document.fonts.check('20px "MinhaFonte"'));
    check("importa uma fonte própria", fontLoaded);

    for (const [width, height] of [[1440, 900], [1366, 768]]) {
      await page.setViewport({ width, height });
      await settle();
      await page.click(`[data-segment-id="${overlayId}"]`);
      const colorPages = await pagesThatScroll();
      check(`seções de cor não rolam em ${width}x${height}`, colorPages.length === 0, colorPages.join(" "));
    }
    await page.setViewport({ width: 1440, height: 900 });
    await settle();
    await openSection(page, "color", "curves");
    await settle();
    await page.screenshot({ path: join(OUT, "curvas.png") });
  }

  {
    const fresh = async (...files) => {
      await clickButton(page, "Novo");
      await page.waitForFunction(() => window.__retalho.getState().project.tracks.length === 0);
      await page.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.textContent === "Mídia").click());
      await (await page.$('[data-testid="file-input"]')).uploadFile(...files);
      await page.waitForFunction(
        (count) => document.querySelectorAll('[data-testid="bin-add"]').length === count,
        { timeout: 20000 },
        files.length,
      );
    };

    await fresh(paths.video);
    await clickBinItem(page, 0);
    await page.waitForSelector(".clip-video");
    await page.click('[data-testid="bin-elements"]');
    await seek(page, 0);
    await page.click('[data-testid="element-adjustment"]');
    await seek(page, 1);
    await openSection(page, "color", "basic");
    await setField("Exposição", -100);
    const adjusted = await previewPixel(20, 20);
    check("camada de ajuste muda o que está abaixo", near(adjusted[0], 64, 10), adjusted.join(","));
    await seek(page, 4.5);
    await settle();
    const adjustedPast = await previewPixel(20, 20);
    await (await page.$$(".clip-text")).at(-1).click();
    await page.keyboard.press("Delete");
    await seek(page, 1);
    await settle();
    const restored = await previewPixel(20, 20);
    check("sem a camada a imagem volta ao normal", restored[0] > 200, `${restored.join(",")} ${adjustedPast.join(",")}`);

    await page.click('[data-testid="element-text"]');
    await openPanel(page, "mask");
    await page.click('[data-testid="matte"]');
    await settle();
    const lettersOfVideo = await countPixels(page, "r>200&&g<60&&b<60");
    const whiteLeft = await countPixels(page, "r>230&&g>230&&b>230");
    const outsideMatte = await previewPixel(20, 20);
    check(
      "recorte mostra o vídeo só dentro das letras",
      lettersOfVideo.count > 500 && lettersOfVideo.count < 150000 && whiteLeft.count === 0 && outsideMatte[0] < 10,
      `${lettersOfVideo.count} pixels vermelhos, fundo ${outsideMatte.join(",")}`,
    );

    await fresh(paths.video);
    await clickBinItem(page, 0);
    await page.waitForSelector(".clip-video");
    await page.click(".clip-video");
    await shortcut(page, "d");
    await settle();
    await (await page.$$(".clip-video"))[0].click();
    await openPanel(page, "transition");
    await page.waitForSelector('[data-testid="transition"]');
    await choose(page, "transition", "iris");
    await seek(page, 3.95);
    await settle();
    const irisCenter = await previewPixel(640, 360);
    const irisCorner = await previewPixel(4, 4);
    check(
      "íris abre um círculo do clipe novo",
      irisCenter[0] > 200 && irisCenter[1] < 60 && irisCorner[1] > 200,
      `${irisCenter.join(",")} / ${irisCorner.join(",")}`,
    );

    await fresh(paths.split);
    await clickBinItem(page, 0);
    await page.waitForSelector(".clip-video");
    await page.click(".clip-video");
    await seek(page, 1);
    await openSection(page, "cut", "frame");
    await page.click('[data-testid="frame"]');
    await settle();
    const roundCorner = await previewPixel(3, 3);
    const stillInside = await previewPixel(60, 60);
    check("moldura arredonda os cantos", roundCorner[2] < 30 && stillInside[2] > 200, `${roundCorner.join(",")} / ${stillInside.join(",")}`);

    const musicPath = join(OUT, "musica.wav");
    writeFileSync(musicPath, wavFile(3, 440));
    const voicePath = join(OUT, "voz-com-pausa.wav");
    writeFileSync(voicePath, pausedTone());
    await fresh(musicPath, voicePath);
    await clickBinItem(page, 0);
    await page.waitForSelector(".clip-audio");
    await seek(page, 0);
    await clickBinItem(page, 1);
    await page.waitForFunction(() => document.querySelectorAll(".clip-audio").length === 2);
    const clipsOfAudio = await page.$$(".clip-audio");
    await clipsOfAudio[0].click();
    await openSection(page, "audio", "auto");
    await page.click('[data-testid="duck"]');
    await page.waitForSelector('[data-testid="duck-clear"]', { timeout: 15000 });
    await page.click('[aria-label="Fechar aviso"]');
    const voiceTrack = (await page.$$('[title="Silenciar"]'))[1];
    await voiceTrack.click();
    const duckUrl = await runExport(page, { format: "wav" });
    const ducked = await decodeWav(duckUrl, `
      const samples = decoded.getChannelData(0);
      const level = (from, to) => {
        let sum = 0;
        for (let index = from * decoded.sampleRate; index < to * decoded.sampleRate; index += 1) sum += samples[index] * samples[index];
        return Math.sqrt(sum / ((to - from) * decoded.sampleRate));
      };
      return { speech: level(0.3, 0.8), pause: level(1.55, 1.75) };
    `);
    await page.click('[data-testid="export-close"]');
    check(
      "música abaixa enquanto há fala",
      ducked.speech < ducked.pause * 0.45 && ducked.pause > 0.2,
      `fala ${ducked.speech.toFixed(3)}, pausa ${ducked.pause.toFixed(3)}`,
    );

    const beatsPath = join(OUT, "ritmo.wav");
    writeFileSync(beatsPath, clickTrack(12, 120));
    await fresh(paths.video, beatsPath);
    await clickBinItem(page, 0);
    await page.waitForSelector(".clip-video");
    await seek(page, 0);
    await clickBinItem(page, 1);
    await page.waitForSelector(".clip-audio");
    await page.click(".clip-audio");
    await openSection(page, "audio", "auto");
    await page.click('[data-testid="mark-beats"]');
    await page.waitForSelector('[data-testid="cut-to-beats"]', { timeout: 20000 });
    await page.click('[data-testid="cut-to-beats"]');
    await settle();
    const videoPieces = (await project(page)).tracks.find((track) => track.type === "video").segments.length;
    check("corta o vídeo no ritmo da música", videoPieces >= 4, `${videoPieces} pedaços`);
  }

  {
    const fresh = async (...files) => {
      await clickButton(page, "Novo");
      await page.waitForFunction(() => window.__retalho.getState().project.tracks.length === 0);
      await (await page.$('[data-testid="file-input"]')).uploadFile(...files);
      await page.waitForFunction(
        (count) => document.querySelectorAll('[data-testid="bin-add"]').length === count,
        { timeout: 20000 },
        files.length,
      );
    };
    const lowTonePath = join(OUT, "grave.wav");
    writeFileSync(lowTonePath, wavFile(3, 120));
    await fresh(lowTonePath);
    await clickBinItem(page, 0);
    await page.waitForSelector(".clip-audio");
    await page.click(".clip-audio");
    const LEVEL = `
      const samples = decoded.getChannelData(0);
      let sum = 0;
      for (let index = decoded.sampleRate; index < decoded.sampleRate * 2; index += 1) sum += samples[index] * samples[index];
      return { level: Math.sqrt(sum / decoded.sampleRate) };
    `;
    const plainUrl = await runExport(page, { format: "wav" });
    const plain = await decodeWav(plainUrl, LEVEL);
    await page.click('[data-testid="export-close"]');
    await openSection(page, "audio", "shaping");
    await setField("Graves", -12);
    const cutUrl = await runExport(page, { format: "wav" });
    const cut = await decodeWav(cutUrl, LEVEL);
    await page.click('[data-testid="export-close"]');
    check("equalizador corta os graves", cut.level < plain.level * 0.5, `${plain.level.toFixed(3)} para ${cut.level.toFixed(3)}`);
    await setField("Graves", 0);

    const pausePath = join(OUT, "eco.wav");
    writeFileSync(pausePath, pausedTone());
    await fresh(pausePath);
    await clickBinItem(page, 0);
    await page.waitForSelector(".clip-audio");
    await page.click(".clip-audio");
    await openSection(page, "audio", "shaping");
    await setField("Reverb", 1);
    const roomUrl = await runExport(page, { format: "wav" });
    const room = await decodeWav(roomUrl, `
      const samples = decoded.getChannelData(0);
      let sum = 0;
      for (let index = decoded.sampleRate * 1.05; index < decoded.sampleRate * 1.5; index += 1) sum += samples[index] * samples[index];
      return { tail: Math.sqrt(sum / (decoded.sampleRate * 0.45)) };
    `);
    await page.click('[data-testid="export-close"]');
    check("reverb deixa eco depois do som parar", room.tail > 0.01, `cauda ${room.tail.toFixed(3)}`);

    const longPath = join(OUT, "emenda.wav");
    writeFileSync(longPath, wavFile(35, 440));
    await fresh(longPath);
    await clickBinItem(page, 0);
    await page.waitForSelector(".clip-audio");
    await page.click(".clip-audio");
    await openSection(page, "audio", "shaping");
    await setField("Agudos", 6);
    const filteredUrl = await runExport(page, { format: "wav" });
    const filtered = await decodeWav(filteredUrl, `
      const samples = decoded.getChannelData(0);
      let jump = 0;
      for (let index = decoded.sampleRate * 29; index < decoded.sampleRate * 31; index += 1) {
        jump = Math.max(jump, Math.abs(samples[index] - samples[index - 1]));
      }
      return { jump };
    `);
    await page.click('[data-testid="export-close"]');
    check("efeitos não fazem clique na emenda da exportação", filtered.jump < 0.05, `maior salto ${filtered.jump.toFixed(4)}`);

    await fresh(paths.video);
    await clickBinItem(page, 0);
    await page.waitForSelector(".clip-video");
    await page.click(".clip-video");
    await shortcut(page, "d");
    await settle();
    const [firstId, secondId] = (await project(page)).tracks[0].segments.map((segment) => segment.id);
    await page.click(`[data-segment-id="${firstId}"]`);
    await page.keyboard.down("Control");
    await page.click(`[data-segment-id="${secondId}"]`);
    await page.keyboard.up("Control");
    const both = await state(page);
    check("Ctrl+clique seleciona dois clipes", (await page.$$(".clip.is-selected")).length === 2, both.selection ? "ok" : "sem seleção");
    await shortcut(page, "g");
    const grouped = (await project(page)).tracks[0].segments.map((segment) => segment.group);
    check("Ctrl+G agrupa", Boolean(grouped[0]) && grouped[0] === grouped[1]);
    await deselect(page);
    await page.click(`[data-segment-id="${secondId}"]`);
    check("clicar em um clipe do grupo seleciona os dois", (await page.$$(".clip.is-selected")).length === 2);
    const clipBox = await (await page.$(`[data-segment-id="${firstId}"]`)).boundingBox();
    await page.mouse.move(clipBox.x + 100, clipBox.y + 20);
    await page.mouse.down();
    await page.mouse.move(clipBox.x + 180, clipBox.y + 20, { steps: 6 });
    await page.mouse.up();
    await settle();
    const dragged = (await project(page)).tracks[0].segments.map((segment) => segment.target.start / 1e6);
    check(
      "arrastar move o grupo inteiro com o mouse",
      near(dragged[0], 1, 0.1) && near(dragged[1] - dragged[0], 4.01, 0.05),
      dragged.map((value) => value.toFixed(2)).join(" "),
    );
    await page.keyboard.press("Delete");
    check("Delete apaga o grupo inteiro", (await project(page)).tracks.length === 0);
  }

  {
    await clickButton(page, "Novo");
    await page.waitForFunction(() => window.__retalho.getState().project.tracks.length === 0);
    await page.click('[data-testid="bin-elements"]');
    await page.click('[data-testid="element-rectangle"]');
    await page.waitForSelector('[data-testid="shape-kind"]');
    await page.evaluate(async () => {
      const ops = await import("/src/core/ops.ts");
      const store = await import("/src/ui/store.ts");
      const id = store.getState().project.tracks[0].segments[0].id;
      store.edit((value) => {
        const shorter = ops.trimEnd(value, id, 1_000_000);
        return ops.updateSegment(shorter, id, (segment) => {
          segment.keyframes = { x: [{ offset: 0, value: -1 }, { offset: 1_000_000, value: 1 }] };
        });
      });
    });
    const gifUrl = await runExport(page, { format: "gif" });
    const gifPath = await saveDownload(page, gifUrl, "saida.gif");
    await page.click('[data-testid="export-close"]');
    const gifInfo = await page.evaluate(async (href) => {
      const bitmap = await createImageBitmap(await (await fetch(href)).blob());
      return { width: bitmap.width, height: bitmap.height };
    }, gifUrl);
    check("exporta GIF que o navegador abre", gifInfo.width === 480 && gifInfo.height === 270, JSON.stringify(gifInfo));
    if (FFMPEG) {
      const info = spawnSync(FFMPEG, ["-hide_banner", "-i", gifPath], { encoding: "utf8" }).stderr;
      check("ffmpeg lê o GIF como animação", /Video: gif/.test(info) && /480x270/.test(info), /Video:.*/.exec(info)?.[0].slice(0, 60));
    }

    const blurredPixels = async (blur) => {
      await page.click('[data-testid="export-open"]');
      await page.waitForSelector('[data-testid="export-start"]');
      await page.select('[data-testid="export-format"]', "mp4");
      await page.select('[data-testid="export-resolution"]', "720");
      if (blur) await page.click('[data-testid="motion-blur"]');
      await page.click('[data-testid="export-start"]');
      await page.waitForSelector('[data-testid="export-done"], .dialog .warning', { timeout: 120000 });
      const href = await page.$eval('[data-testid="export-link"]', (link) => link.href);
      const count = await page.evaluate(async (url) => {
        const video = document.createElement("video");
        video.muted = true;
        video.src = url;
        await new Promise((done) => { video.onloadeddata = done; });
        video.currentTime = 0.5;
        await new Promise((done) => { video.onseeked = done; });
        await new Promise((done) => setTimeout(done, 300));
        const canvas = new OffscreenCanvas(video.videoWidth, video.videoHeight);
        const context = canvas.getContext("2d");
        context.drawImage(video, 0, 0);
        const { data } = context.getImageData(0, canvas.height / 2, canvas.width, 1);
        let partial = 0;
        for (let x = 0; x < canvas.width; x += 1) if (data[x * 4] > 40 && data[x * 4] < 200) partial += 1;
        return partial;
      }, href);
      await page.click('[data-testid="export-close"]');
      return count;
    };
    const sharp = await blurredPixels(false);
    const smeared = await blurredPixels(true);
    check("desfoque de movimento borra as bordas em movimento", smeared > sharp + 15, `${sharp} para ${smeared} pixels de transição`);
  }

  {
    await clickButton(page, "Novo");
    await page.waitForFunction(() => window.__retalho.getState().project.tracks.length === 0);
    await page.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.textContent === "Mídia").click());
    await (await page.$('[data-testid="file-input"]')).uploadFile(paths.split);
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="bin-add"]').length === 1, { timeout: 20000 });
    await clickBinItem(page, 0);
    await page.waitForSelector(".clip-video");
    const nameInput = '[aria-label="Nome do projeto"]';
    await setInput(page, nameInput, "Projeto A");
    await settle();
    await settle();
    const firstProject = (await project(page)).id;

    await clickButton(page, "Novo");
    await page.waitForFunction((id) => window.__retalho.getState().project.id !== id, {}, firstProject);
    await page.waitForFunction(() => window.__retalho.getState().project.tracks.length === 0);
    await page.click('[data-testid="bin-elements"]');
    await page.click('[data-testid="template-lowerThird"]');
    await page.waitForSelector(".clip-text");
    await seek(page, 2);
    await settle();
    const bar = await countPixels(page, "r>200&&g>80&&g<190&&b<90");
    check("modelo animado aparece no preview", bar.count > 3000 && bar.top > 400, `${bar.count} pixels, a partir de y ${bar.top}`);
    check("modelo entra como grupo", (await page.$$(".clip.is-selected")).length === 2);
    await setInput(page, nameInput, "Projeto B");
    await settle();
    await settle();

    await page.click('[data-testid="projects-open"]');
    await page.waitForSelector('[data-testid="project-open"]');
    const names = await page.$$eval(".project-open strong", (items) => items.map((item) => item.textContent));
    check("lista os projetos salvos", names.includes("Projeto A") && names.includes("Projeto B"), names.slice(0, 4).join(", "));
    const openFirst = await page.evaluateHandle(
      () => [...document.querySelectorAll(".project-open")].find((item) => item.textContent.includes("Projeto A")),
    );
    await openFirst.click();
    await page.waitForFunction((id) => window.__retalho.getState().project.id === id, { timeout: 15000 }, firstProject);
    await seek(page, 1);
    await settle();
    const reopenedMedia = await previewPixel(20, 360);
    check("reabre outro projeto com a mídia", reopenedMedia[2] > 200, reopenedMedia.join(","));

    await page.click('[data-testid="projects-open"]');
    await page.waitForSelector('[data-testid="project-delete"]');
    const before = (await page.$$(".project-open")).length;
    const removeB = await page.evaluateHandle(() =>
      [...document.querySelectorAll(".project-list li")].find((item) => item.textContent.includes("Projeto B")).querySelector('[data-testid="project-delete"]'),
    );
    await removeB.click();
    await page.waitForFunction((count) => document.querySelectorAll(".project-open").length === count - 1, { timeout: 10000 }, before);
    check("apaga um projeto da lista", true);
    await clickButton(page, "Fechar");
    await seek(page, 1.5);
    await settle();
    check("apagar outro projeto não toca nas mídias do atual", (await previewPixel(20, 360))[2] > 200);

    await page.evaluate(async () => {
      const { addSubtitles } = await import("/src/core/subtitles.ts");
      const store = await import("/src/ui/store.ts");
      store.edit((value) =>
        addSubtitles(value, [
          { start: 0, end: 1_000_000, text: "Bom dia Retalo" },
          { start: 2_000_000, end: 3_000_000, text: "O Retalo edita" },
        ]),
      );
    });
    await page.click('[data-testid="bin-transcript"]');
    await page.waitForSelector('[data-testid="view-captions"]');
    await page.click('[data-testid="view-captions"]');
    await page.waitForSelector('[data-testid="caption-find"]');
    await page.type('[data-testid="caption-find"]', "Retalo");
    await page.type('[data-testid="caption-replace"]', "Retalho");
    await page.click('[data-testid="caption-replace-all"]');
    await settle();
    const rows = await page.$$eval('[data-testid="caption-text"]', (items) => items.map((item) => item.value));
    check("busca e troca em todas as legendas", rows.length === 2 && rows.every((text) => text.includes("Retalho")), rows.join(" | "));
    await page.screenshot({ path: join(OUT, "legendas.png") });
    await page.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.textContent === "Mídia").click());
  }

  {
    await page.click(".clip-video");
    await seek(page, 0);
    await settle();
    await openSection(page, "color", "basic");
    await page.click('[aria-label="Keyframe de Brilho"]');
    await seek(page, 2);
    await settle();
    await page.click('[aria-label="Keyframe de Brilho"]');
    await settle();
    await setInput(page, 'input[type="range"][aria-label="Brilho"]', "-100");
    await settle();
    const bright = await (async () => { await seek(page, 0); await settle(); return previewPixel(20, 360); })();
    const middle = await (async () => { await seek(page, 1); await settle(); return previewPixel(20, 360); })();
    const dark = await (async () => { await seek(page, 2); await settle(); return previewPixel(20, 360); })();
    check("keyframes de brilho animam o preview", bright[2] > 200 && middle[2] < bright[2] && middle[2] > dark[2] && dark[2] < 40, `${bright[2]} ${middle[2]} ${dark[2]}`);
    const shown = await page.$eval('input[type="range"][aria-label="Brilho"]', (input) => Number(input.value));
    check("controle acompanha o cursor", shown === -100, String(shown));
    const pages = await pagesThatScroll();
    check("página de cor com losangos não rola", pages.length === 0, pages.join(", "));
    await page.screenshot({ path: join(OUT, "keyframes-cor.png") });
    await clickButton(page, "Desfazer");
    await clickButton(page, "Desfazer");
    await clickButton(page, "Desfazer");
    await settle();
  }

  const realDraft = process.env.RETALHO_REAL_DRAFT;
  if (realDraft && existsSync(realDraft)) {
    const draftInput = await page.$('[data-testid="file-input"]');
    await draftInput.uploadFile(realDraft);
    await page.waitForSelector('[data-testid="notice"]', { timeout: 15000 });
    await new Promise((done) => setTimeout(done, 600));
    const imported = await state(page);
    check(
      "importa draft real",
      imported.tracks.length > 0 && imported.materials.every((m) => m.kind === "text" || m.offline),
      `${imported.tracks.length} faixas`,
    );
    await seek(page, 2);
    await new Promise((done) => setTimeout(done, 500));
    await page.click('[aria-label="Fechar aviso"]');
    await new Promise((done) => setTimeout(done, 200));
    await page.screenshot({ path: join(OUT, "draft-importado.png") });
    const fitted = await page.evaluate(() => {
      const canvas = document.querySelector('[data-testid="preview"]').getBoundingClientRect();
      const stage = document.querySelector(".preview-stage").getBoundingClientRect();
      return {
        ratio: canvas.width / canvas.height,
        inside: canvas.top >= stage.top - 1 && canvas.bottom <= stage.bottom + 1 && canvas.left >= stage.left - 1 && canvas.right <= stage.right + 1,
      };
    });
    check("preview vertical cabe inteiro e mantém a proporção", fitted.inside && Math.abs(fitted.ratio - 9 / 16) < 0.01, JSON.stringify(fitted));
  }

  check("sem erros no console", errors.length === 0, errors.slice(0, 3).join(" | "));
} catch (error) {
  check("execução do teste", false, error.stack);
} finally {
  await browser?.close();
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(server.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    server.kill();
  }
}

const failed = results.filter((passed) => !passed).length;
console.log(`\n${results.length - failed}/${results.length} verificações passaram`);
process.exit(failed ? 1 : 0);
