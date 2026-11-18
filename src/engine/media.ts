import type { LutTable } from "../core/cube";
import { SECOND, type MediaKind, type MediaMaterial, type TimeRange, type Us } from "../core/model";
import { AudioStream } from "./audioStream";

const PEAKS_PER_SECOND = 50;
const COVER_HEIGHT = 96;
const FRAME_TOLERANCE_SECONDS = 0.02;
const SEEK_TIMEOUT_MS = 4000;
const SETTLE_TIMEOUT_MS = 120;
/** Past either limit, sound is read in parts instead of being decoded into memory at once. */
const WHOLE_AUDIO_SECONDS = 20 * 60;
const WHOLE_FILE_BYTES = 768 * 1024 * 1024;
const PROXY_KEY = ":proxy";

export interface Probe {
  kind: MediaKind;
  duration: Us;
  width: number;
  height: number;
  hasAudio: boolean;
}

export function mediaKindOf(file: File): MediaKind | null {
  const [family] = file.type.split("/");
  if (family === "video" || family === "audio") return family;
  if (family === "image") return "image";
  if (/\.(mp4|mov|webm|mkv|m4v)$/i.test(file.name)) return "video";
  if (/\.(mp3|wav|m4a|aac|ogg|flac)$/i.test(file.name)) return "audio";
  if (/\.(png|jpe?g|webp|gif|bmp|avif)$/i.test(file.name)) return "image";
  return null;
}

function whenEvent(target: EventTarget, success: string, failure = "error"): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = (handler: () => void) => () => {
      target.removeEventListener(success, onSuccess);
      target.removeEventListener(failure, onFailure);
      handler();
    };
    const onSuccess = done(resolve);
    const onFailure = done(() => reject(new Error(`Falha ao ler a mídia (${failure})`)));
    target.addEventListener(success, onSuccess);
    target.addEventListener(failure, onFailure);
  });
}

async function decodeAudio(blob: Blob): Promise<AudioBuffer | null> {
  try {
    const context = new OfflineAudioContext(2, 1, 48000);
    return await context.decodeAudioData(await blob.arrayBuffer());
  } catch {
    return null;
  }
}

function computePeaks(buffer: AudioBuffer): Float32Array {
  const channel = buffer.getChannelData(0);
  const count = Math.max(1, Math.ceil(buffer.duration * PEAKS_PER_SECOND));
  const size = Math.max(1, Math.floor(channel.length / count));
  const peaks = new Float32Array(count);
  for (let index = 0; index < count; index += 1) {
    let peak = 0;
    const end = Math.min(channel.length, (index + 1) * size);
    for (let sample = index * size; sample < end; sample += 1) {
      peak = Math.max(peak, Math.abs(channel[sample]!));
    }
    peaks[index] = peak;
  }
  return peaks;
}

function coverFrom(source: CanvasImageSource, width: number, height: number): string {
  const canvas = document.createElement("canvas");
  canvas.height = COVER_HEIGHT;
  canvas.width = Math.max(1, Math.round((width / height) * COVER_HEIGHT));
  canvas.getContext("2d")!.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.7);
}

export function waitForSeek(video: HTMLVideoElement, seconds: number): Promise<void> {
  const limit = Number.isFinite(video.duration) ? Math.max(0, video.duration - 0.001) : seconds;
  const target = Math.min(seconds, limit);
  if (Math.abs(video.currentTime - target) < 0.0005 && video.readyState >= 2 && !video.seeking) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let callback = 0;
    let seeked = false;
    const finish = () => {
      window.clearTimeout(timer);
      video.removeEventListener("seeked", onSeeked);
      video.cancelVideoFrameCallback(callback);
      resolve();
    };
    // The seeked event fires before the new frame is guaranteed to be drawable,
    // so a frame only counts once it has been presented at the wanted time.
    const onFrame: VideoFrameRequestCallback = (_now, metadata) => {
      const near = Math.abs(metadata.mediaTime - target) <= FRAME_TOLERANCE_SECONDS;
      if (near || seeked) finish();
      else callback = video.requestVideoFrameCallback(onFrame);
    };
    const onSeeked = () => {
      seeked = true;
      window.clearTimeout(timer);
      // The frame may have been presented just before seeked, leaving nothing to wait for.
      timer = window.setTimeout(finish, SETTLE_TIMEOUT_MS);
    };
    // A corrupt file can never fire seeked; drawing a stale frame beats hanging.
    let timer = window.setTimeout(finish, SEEK_TIMEOUT_MS);
    video.addEventListener("seeked", onSeeked);
    callback = video.requestVideoFrameCallback(onFrame);
    video.currentTime = target;
  });
}

/** Holds decoded media. Video elements are per segment so one file can play twice in a transition. */
export class MediaPool {
  private blobs = new Map<string, Blob>();
  private urls = new Map<string, string>();
  private images = new Map<string, ImageBitmap>();
  private audio = new Map<string, AudioBuffer>();
  private streams = new Map<string, AudioStream>();
  private peaks = new Map<string, Float32Array>();
  private covers = new Map<string, string>();
  private videos = new Map<string, HTMLVideoElement>();
  private proxies = new Map<string, string>();
  /** Editing shows the light copies when they exist. */
  useProxies = false;
  /** Set while exporting, which must always read the originals. */
  fullQuality = false;
  /** Lets a test exercise reading in parts with short files. */
  forceStreaming = false;
  /** Called when a waveform finishes in the background. */
  onWaveform: (() => void) | null = null;
  private luts = new Map<string, { table: LutTable; blob: Blob }>();
  private fonts = new Map<string, Blob>();

  /** Reads duration, size and audio presence, and keeps everything needed to play the file. */
  async register(id: string, blob: Blob, kind: MediaKind): Promise<Probe> {
    this.forget(id);
    this.blobs.set(id, blob);
    const url = URL.createObjectURL(blob);
    this.urls.set(id, url);

    if (kind === "image") {
      const bitmap = await createImageBitmap(blob);
      this.images.set(id, bitmap);
      this.covers.set(id, coverFrom(bitmap, bitmap.width, bitmap.height));
      return { kind, duration: 0, width: bitmap.width, height: bitmap.height, hasAudio: false };
    }

    const stream = await AudioStream.open(blob).catch(() => null);
    const inParts =
      stream && (this.forceStreaming || blob.size > WHOLE_FILE_BYTES || stream.duration > WHOLE_AUDIO_SECONDS);
    const buffer = inParts ? null : await decodeAudio(blob);
    if (buffer) {
      this.audio.set(id, buffer);
      this.peaks.set(id, computePeaks(buffer));
    } else if (inParts) {
      this.streams.set(id, stream);
      void this.scanPeaks(id, stream);
    }
    const seconds = buffer?.duration ?? (inParts ? stream.duration : 0);
    if (kind === "audio") {
      if (!seconds) throw new Error("Formato de áudio não suportado");
      return {
        kind,
        duration: Math.round(seconds * SECOND),
        width: 0,
        height: 0,
        hasAudio: true,
      };
    }

    const video = document.createElement("video");
    video.muted = true;
    video.preload = "auto";
    video.src = url;
    await whenEvent(video, "loadeddata");
    let length = video.duration;
    if (!Number.isFinite(length)) {
      // Recorded WebM files report no duration until the end has been read.
      await waitForSeek(video, 1e7);
      length = video.duration;
    }
    await waitForSeek(video, Math.min(0.1, length / 2));
    this.covers.set(id, coverFrom(video, video.videoWidth, video.videoHeight));
    const probe: Probe = {
      kind,
      duration: Math.round(length * SECOND),
      width: video.videoWidth,
      height: video.videoHeight,
      hasAudio: seconds > 0,
    };
    video.removeAttribute("src");
    video.load();
    return probe;
  }

  has(id: string): boolean {
    return this.blobs.has(id);
  }

  url(id: string): string | undefined {
    return this.urls.get(id);
  }

  blob(id: string): Blob | undefined {
    return this.blobs.get(id) ?? this.luts.get(id)?.blob ?? this.fonts.get(id);
  }

  /** Makes a font usable by name, on screen and in exports. */
  async addFont(id: string, name: string, blob: Blob): Promise<void> {
    const face = new FontFace(name, await blob.arrayBuffer());
    await face.load();
    document.fonts.add(face);
    this.fonts.set(id, blob);
  }

  addLut(id: string, table: LutTable, blob: Blob): void {
    this.luts.set(id, { table, blob });
  }

  lut(id: string): LutTable | undefined {
    return this.luts.get(id)?.table;
  }

  image(id: string): ImageBitmap | undefined {
    return this.images.get(id);
  }

  audioBuffer(id: string): AudioBuffer | undefined {
    return this.audio.get(id);
  }

  hasSound(id: string): boolean {
    return this.audio.has(id) || this.streams.has(id);
  }

  isStreamed(id: string): boolean {
    return this.streams.has(id);
  }

  /** A stretch of sound, wherever it is kept. */
  async readAudio(id: string, range: TimeRange): Promise<AudioBuffer | null> {
    const stream = this.streams.get(id);
    if (stream) return stream.read(range.start / SECOND, range.duration / SECOND);
    const whole = this.audio.get(id);
    if (!whole) return null;
    const start = Math.round((range.start / SECOND) * whole.sampleRate);
    const end = Math.min(whole.length, start + Math.round((range.duration / SECOND) * whole.sampleRate));
    if (end <= start) return null;
    const part = new AudioBuffer({
      length: end - start,
      numberOfChannels: whole.numberOfChannels,
      sampleRate: whole.sampleRate,
    });
    for (let channel = 0; channel < whole.numberOfChannels; channel += 1) {
      part.copyToChannel(whole.getChannelData(channel).subarray(start, end), channel);
    }
    return part;
  }

  /** Builds a waveform by reading through the file, without holding on to the sound. */
  private async scanPeaks(id: string, stream: AudioStream): Promise<void> {
    const peaks = new Float32Array(Math.max(1, Math.ceil(stream.duration * PEAKS_PER_SECOND)));
    try {
      for await (const { buffer, timestamp } of stream.pieces()) {
        const samples = buffer.getChannelData(0);
        for (let index = 0; index < samples.length; index += 1) {
          const slot = Math.floor((timestamp + index / buffer.sampleRate) * PEAKS_PER_SECOND);
          if (slot < peaks.length) peaks[slot] = Math.max(peaks[slot]!, Math.abs(samples[index]!));
        }
      }
    } catch (error) {
      console.warn("Não foi possível desenhar a forma de onda", error);
      return;
    }
    if (!this.streams.has(id)) return;
    this.peaks.set(id, peaks);
    this.onWaveform?.();
  }

  waveform(id: string): { peaks: Float32Array; perSecond: number } | null {
    const peaks = this.peaks.get(id);
    return peaks ? { peaks, perSecond: PEAKS_PER_SECOND } : null;
  }

  cover(id: string): string | undefined {
    return this.covers.get(id);
  }

  addProxy(id: string, file: Blob): void {
    const previous = this.proxies.get(id);
    if (previous) URL.revokeObjectURL(previous);
    this.proxies.set(id, URL.createObjectURL(file));
  }

  hasProxy(id: string): boolean {
    return this.proxies.has(id);
  }

  videoFor(segmentId: string, material: MediaMaterial): HTMLVideoElement | null {
    const proxy = this.useProxies && !this.fullQuality ? this.proxies.get(material.id) : undefined;
    const url = proxy ?? this.urls.get(material.id);
    if (!url) return null;
    // Each version keeps its own element, so switching never has to reload a video.
    const key = proxy ? `${segmentId}${PROXY_KEY}` : segmentId;
    let video = this.videos.get(key);
    if (!video || video.dataset.material !== material.id) {
      video = document.createElement("video");
      video.muted = true;
      video.playsInline = true;
      video.preload = "auto";
      video.dataset.material = material.id;
      video.src = url;
      this.videos.set(key, video);
    }
    return video;
  }

  pauseExcept(active: Set<string>): void {
    for (const [key, video] of this.videos) {
      if (!active.has(key.replace(PROXY_KEY, "")) && !video.paused) video.pause();
    }
  }

  private forget(id: string): void {
    const url = this.urls.get(id);
    if (url) URL.revokeObjectURL(url);
    this.urls.delete(id);
    this.blobs.delete(id);
    this.images.get(id)?.close();
    this.images.delete(id);
    this.audio.delete(id);
    this.streams.delete(id);
    const proxy = this.proxies.get(id);
    if (proxy) URL.revokeObjectURL(proxy);
    this.proxies.delete(id);
    this.peaks.delete(id);
    this.covers.delete(id);
    for (const [segmentId, video] of this.videos) {
      if (video.dataset.material === id) {
        video.pause();
        video.removeAttribute("src");
        video.load();
        this.videos.delete(segmentId);
      }
    }
  }

  clear(): void {
    for (const id of [...this.blobs.keys()]) this.forget(id);
    this.luts.clear();
    this.fonts.clear();
  }
}

export const pool = new MediaPool();
