import { FileSystemWritableFileStreamTarget, Muxer } from "mp4-muxer";
import { SECOND, frameDuration, outputSize, projectDuration, type Project, type Us } from "../core/model";
import { audioPlan, resolveFrame } from "../core/resolve";
import { GifWriter } from "../core/gif";
import { wavHeader, wavSamples } from "../core/wav";
import { readsInParts, scheduleAudio, scheduleParts } from "./audio";
import { prepareAudio } from "./audioJobs";
import { drawFrame } from "./compositor";
import { pool } from "./media";
import { prepareExactFrame } from "./player";

const SAMPLE_RATE = 48000;
const AUDIO_CHUNK_FRAMES = 4096;
const KEYFRAME_SECONDS = 2;
const MAX_QUEUED_FRAMES = 6;
/** Sound is rendered in stretches, so its length never decides how much memory it takes. */
const AUDIO_WINDOW_SECONDS = 30;
/** Each window starts early and drops this much, so filters and echoes are already settled at the join. */
const AUDIO_LEAD_SECONDS = 3;
const TEMPORARY_EXPORT = "retalho-exportacao.mp4";
/** GIF timing comes in hundredths of a second, so this rate is one the format can keep exactly. */
const GIF_FRAMES_PER_SECOND = 12.5;
const GIF_LONG_SIDE = 480;
/** Moments blended into each frame, spread over half of it, like a film camera's shutter. */
const MOTION_BLUR_SAMPLES = 6;
const SHUTTER = 0.5;

type VideoMuxCodec = "avc" | "vp9";
type AudioMuxCodec = "aac" | "opus";

export interface ExportOptions {
  /** Bits per pixel per frame; drives quality against file size. */
  quality: number;
  /** Target short side in pixels; zero keeps the project size. */
  shortSide?: number;
  /** Overrides the project frame rate. */
  fps?: number;
  /** Blends moments within each frame, so fast moves smear like on film. */
  motionBlur?: boolean;
  signal: AbortSignal;
  onProgress(fraction: number): void;
}

export interface ExportResult {
  blob: Blob;
  videoCodec: VideoMuxCodec;
  audioCodec: AudioMuxCodec | null;
}

async function pickVideoCodec(width: number, height: number, bitrate: number, framerate: number) {
  const candidates: { mux: VideoMuxCodec; codec: string }[] = [
    { mux: "avc", codec: "avc1.640033" },
    { mux: "avc", codec: "avc1.640034" },
    { mux: "avc", codec: "avc1.4d0033" },
    { mux: "vp9", codec: "vp09.00.51.08" },
  ];
  for (const { mux, codec } of candidates) {
    const config: VideoEncoderConfig = { codec, width, height, bitrate, framerate };
    const { supported } = await VideoEncoder.isConfigSupported(config);
    if (supported) return { mux, config };
  }
  throw new Error("Este navegador não tem um codificador de vídeo compatível.");
}

async function pickAudioCodec() {
  const candidates: { mux: AudioMuxCodec; codec: string }[] = [
    { mux: "aac", codec: "mp4a.40.2" },
    { mux: "opus", codec: "opus" },
  ];
  for (const { mux, codec } of candidates) {
    const config: AudioEncoderConfig = {
      codec,
      sampleRate: SAMPLE_RATE,
      numberOfChannels: 2,
      bitrate: 192_000,
    };
    const { supported } = await AudioEncoder.isConfigSupported(config);
    if (supported) return { mux, config };
  }
  return null;
}

/** Renders the whole mix window by window. The timeline's end is always on a sample. */
async function* renderAudio(project: Project): AsyncGenerator<{ buffer: AudioBuffer; firstFrame: number }> {
  const total = Math.ceil((projectDuration(project) / SECOND) * SAMPLE_RATE);
  const windowFrames = AUDIO_WINDOW_SECONDS * SAMPLE_RATE;
  for (let firstFrame = 0; firstFrame < total; firstFrame += windowFrames) {
    const lead = Math.min(firstFrame, AUDIO_LEAD_SECONDS * SAMPLE_RATE);
    const from = Math.round(((firstFrame - lead) / SAMPLE_RATE) * SECOND);
    const length = Math.min(windowFrames, total - firstFrame) + lead;
    const end = from + Math.round((length / SAMPLE_RATE) * SECOND);
    const context = new OfflineAudioContext(2, length, SAMPLE_RATE);
    const events = audioPlan(project, from).filter((event) => event.at < end && !readsInParts(event));
    scheduleAudio(context, context.destination, events, from, 0);
    await scheduleParts(context, context.destination, project, from, 0, length / SAMPLE_RATE);
    const rendered = await context.startRendering();
    yield { buffer: lead ? withoutLead(rendered, lead) : rendered, firstFrame };
  }
}

function withoutLead(buffer: AudioBuffer, lead: number): AudioBuffer {
  const result = new AudioBuffer({
    length: buffer.length - lead,
    numberOfChannels: buffer.numberOfChannels,
    sampleRate: buffer.sampleRate,
  });
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    result.copyToChannel(buffer.getChannelData(channel).subarray(lead), channel);
  }
  return result;
}

function encodeAudio(buffer: AudioBuffer, firstFrame: number, encoder: AudioEncoder): void {
  const left = buffer.getChannelData(0);
  const right = buffer.getChannelData(1);
  for (let start = 0; start < buffer.length; start += AUDIO_CHUNK_FRAMES) {
    const frames = Math.min(AUDIO_CHUNK_FRAMES, buffer.length - start);
    const planar = new Float32Array(frames * 2);
    planar.set(left.subarray(start, start + frames), 0);
    planar.set(right.subarray(start, start + frames), frames);
    const data = new AudioData({
      format: "f32-planar",
      sampleRate: SAMPLE_RATE,
      numberOfFrames: frames,
      numberOfChannels: 2,
      timestamp: Math.round(((firstFrame + start) / SAMPLE_RATE) * SECOND),
      data: planar,
    });
    encoder.encode(data);
    data.close();
  }
}

let blurLayer: OffscreenCanvasRenderingContext2D | null = null;

/** Averages several moments: each new one goes on top at a share that keeps them all equal. */
async function drawBlurredFrame(
  context: OffscreenCanvasRenderingContext2D,
  width: number,
  height: number,
  project: Project,
  time: number,
  frameLength: number,
): Promise<void> {
  blurLayer ??= new OffscreenCanvas(width, height).getContext("2d")!;
  const { canvas } = blurLayer;
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  for (let sample = 0; sample < MOTION_BLUR_SAMPLES; sample += 1) {
    const moment = Math.round(time + (frameLength * SHUTTER * sample) / MOTION_BLUR_SAMPLES);
    const layers = resolveFrame(project, moment);
    await prepareExactFrame(layers);
    drawFrame(blurLayer, width, height, project, layers);
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.globalCompositeOperation = "source-over";
    context.filter = "none";
    context.globalAlpha = 1 / (sample + 1);
    context.drawImage(canvas, 0, 0);
  }
  context.globalAlpha = 1;
}

function waitForQueue(encoder: VideoEncoder): Promise<void> {
  if (encoder.encodeQueueSize <= MAX_QUEUED_FRAMES) return Promise.resolve();
  return new Promise((resolve) => {
    encoder.addEventListener("dequeue", () => resolve(), { once: true });
  });
}

/** Encoded video goes straight to a temporary file, since a long export would not fit in memory. */
async function temporaryFile(): Promise<{ handle: FileSystemFileHandle; stream: FileSystemWritableFileStream }> {
  const folder = await navigator.storage.getDirectory();
  await folder.removeEntry(TEMPORARY_EXPORT).catch(() => undefined);
  const handle = await folder.getFileHandle(TEMPORARY_EXPORT, { create: true });
  return { handle, stream: await handle.createWritable() };
}

/** Renders offline frame by frame, so the file is exact however slow the machine is. */
/** The file always comes from the originals, whatever the editor is previewing. */
async function withOriginals<T>(work: () => Promise<T>): Promise<T> {
  pool.fullQuality = true;
  try {
    return await work();
  } finally {
    pool.fullQuality = false;
  }
}

export function exportProject(source: Project, options: ExportOptions): Promise<ExportResult> {
  return withOriginals(() => renderVideo(source, options));
}

async function renderVideo(
  source: Project,
  { quality, shortSide, fps, motionBlur, signal, onProgress }: ExportOptions,
): Promise<ExportResult> {
  // The frame rate also decides where a held frame stops, so it replaces the project's.
  const project = fps ? { ...source, fps } : source;
  const { width, height } = outputSize(project.canvas, shortSide);
  const bitrate = Math.round(width * height * project.fps * quality);
  const video = await pickVideoCodec(width, height, bitrate, project.fps);

  const events = audioPlan(project, 0);
  await prepareAudio(events);
  const audio = events.length ? await pickAudioCodec() : null;

  const { handle, stream } = await temporaryFile();
  const muxer = new Muxer({
    target: new FileSystemWritableFileStreamTarget(stream),
    fastStart: false,
    firstTimestampBehavior: "offset",
    video: { codec: video.mux, width, height, frameRate: project.fps },
    ...(audio
      ? { audio: { codec: audio.mux, numberOfChannels: 2, sampleRate: SAMPLE_RATE } }
      : {}),
  });

  let failure: Error | null = null;
  const fail = (error: Error) => {
    failure ??= error;
  };
  const videoEncoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: fail,
  });
  videoEncoder.configure(video.config);

  try {
    if (audio) {
      const audioEncoder = new AudioEncoder({
        output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
        error: fail,
      });
      audioEncoder.configure(audio.config);
      for await (const { buffer, firstFrame } of renderAudio(project)) {
        if (signal.aborted) throw new DOMException("Exportação cancelada", "AbortError");
        encodeAudio(buffer, firstFrame, audioEncoder);
      }
      await audioEncoder.flush();
      audioEncoder.close();
    }

    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d", { willReadFrequently: false })!;
    const totalFrames = Math.max(1, Math.round((projectDuration(project) / SECOND) * project.fps));
    const frameLength = SECOND / project.fps;
    const keyInterval = Math.round(project.fps * KEYFRAME_SECONDS);

    for (let index = 0; index < totalFrames; index += 1) {
      if (signal.aborted) throw new DOMException("Exportação cancelada", "AbortError");
      if (failure) throw failure;
      const time = Math.round(index * frameLength);
      if (motionBlur) {
        await drawBlurredFrame(context, width, height, project, time, frameLength);
      } else {
        const layers = resolveFrame(project, time);
        await prepareExactFrame(layers);
        drawFrame(context, width, height, project, layers);
      }
      const frame = new VideoFrame(canvas, { timestamp: time, duration: Math.round(frameLength) });
      videoEncoder.encode(frame, { keyFrame: index % keyInterval === 0 });
      frame.close();
      await waitForQueue(videoEncoder);
      onProgress((index + 1) / totalFrames);
    }

    await videoEncoder.flush();
    if (failure) throw failure;
  } catch (error) {
    await stream.abort().catch(() => undefined);
    throw error;
  } finally {
    if (videoEncoder.state !== "closed") videoEncoder.close();
  }

  muxer.finalize();
  await stream.close();
  return {
    blob: await handle.getFile(),
    videoCodec: video.mux,
    audioCodec: audio?.mux ?? null,
  };
}

export async function exportAudio(project: Project): Promise<Blob> {
  const events = audioPlan(project, 0);
  if (events.length === 0) throw new Error("O projeto não tem áudio para exportar.");
  await prepareAudio(events);
  const parts: BlobPart[] = [];
  let frames = 0;
  for await (const { buffer } of renderAudio(project)) {
    parts.push(new Blob([wavSamples([buffer.getChannelData(0), buffer.getChannelData(1)])]));
    frames += buffer.length;
  }
  return new Blob([wavHeader(frames, 2, SAMPLE_RATE), ...parts], { type: "audio/wav" });
}

/** The frame at a time, at project size. The end of the timeline shows the last frame. */
export function exportStill(project: Project, time: Us): Promise<Blob> {
  return withOriginals(async () => {
    const { width, height } = outputSize(project.canvas);
    const last = Math.max(0, projectDuration(project) - frameDuration(project));
    const layers = resolveFrame(project, Math.min(time, last));
    await prepareExactFrame(layers);
    const canvas = new OffscreenCanvas(width, height);
    drawFrame(canvas.getContext("2d")!, width, height, project, layers);
    return canvas.convertToBlob({ type: "image/png" });
  });
}

/** A looping GIF, small enough to share. Colours are limited, as the format requires. */
export function exportGif(
  project: Project,
  { signal, onProgress }: Pick<ExportOptions, "signal" | "onProgress">,
): Promise<Blob> {
  return withOriginals(async () => {
    const scale = GIF_LONG_SIDE / Math.max(project.canvas.width, project.canvas.height);
    const width = Math.round(project.canvas.width * scale);
    const height = Math.round(project.canvas.height * scale);
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d", { willReadFrequently: true })!;
    const writer = new GifWriter(width, height, Math.round(100 / GIF_FRAMES_PER_SECOND));
    const total = Math.max(1, Math.round((projectDuration(project) / SECOND) * GIF_FRAMES_PER_SECOND));
    for (let index = 0; index < total; index += 1) {
      if (signal.aborted) throw new DOMException("Exportação cancelada", "AbortError");
      const layers = resolveFrame(project, Math.round((index / GIF_FRAMES_PER_SECOND) * SECOND));
      await prepareExactFrame(layers);
      drawFrame(context, width, height, project, layers);
      writer.addFrame(context.getImageData(0, 0, width, height).data);
      onProgress((index + 1) / total);
      // Encoding is heavy, and the bar should keep moving.
      await new Promise((resolve) => setTimeout(resolve));
    }
    return writer.finish();
  });
}
