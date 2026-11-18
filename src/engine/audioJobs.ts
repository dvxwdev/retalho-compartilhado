import type { LoudnessReport } from "../core/loudness";
import { WINDOW_SECONDS, type Pause } from "../core/pauses";
import { SECOND, type TimeRange } from "../core/model";
import type { AudioEvent } from "../core/resolve";
import type { AudioJob, AudioJobRequest } from "./audio.worker";
import { pool } from "./media";

let worker: Worker | null = null;
let nextId = 0;
const waiting = new Map<number, { resolve(result: unknown): void; reject(error: Error): void }>();

/** Finished clips kept for reuse; old ones are dropped past this count, unless still in use. */
const MAX_PROCESSED = 48;
const RATE_TOLERANCE = 0.001;

const processed = new Map<string, AudioBuffer>();
const running = new Map<string, Promise<void>>();

function audioWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL("./audio.worker.ts", import.meta.url), { type: "module" });
  worker.onmessage = ({ data }: MessageEvent<{ id: number; result?: unknown; error?: string }>) => {
    const job = waiting.get(data.id);
    waiting.delete(data.id);
    if (data.error) job?.reject(new Error(data.error));
    else job?.resolve(data.result);
  };
  worker.onerror = (event) => {
    for (const job of waiting.values()) job.reject(new Error(event.message));
    waiting.clear();
  };
  return worker;
}

/** Sends a job away. The channels are handed over, so they must be copies. */
export function runAudioJob<T>(job: AudioJob): Promise<T> {
  const id = (nextId += 1);
  const request: AudioJobRequest = { id, job };
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve: resolve as (result: unknown) => void, reject });
    audioWorker().postMessage(request, job.channels.map((channel) => channel.buffer as ArrayBuffer));
  });
}

/** The samples of a source range, as copies that can be handed to the worker. */
async function clipChannels(
  materialId: string,
  range: TimeRange,
): Promise<{ channels: Float32Array[]; sampleRate: number } | null> {
  const buffer = await pool.readAudio(materialId, range);
  if (!buffer) return null;
  const channels: Float32Array[] = [];
  for (let index = 0; index < buffer.numberOfChannels; index += 1) {
    channels.push(buffer.getChannelData(index).slice());
  }
  return { channels, sampleRate: buffer.sampleRate };
}

export async function measureClip(materialId: string, range: TimeRange): Promise<LoudnessReport | null> {
  const clip = await clipChannels(materialId, range);
  return clip && runAudioJob<LoudnessReport>({ kind: "loudness", channels: clip.channels });
}

/** Beats of a source range, in source time. */
export async function findBeats(materialId: string, range: TimeRange): Promise<number[] | null> {
  const clip = await clipChannels(materialId, range);
  if (!clip) return null;
  const seconds = await runAudioJob<number[]>({ kind: "beats", ...clip });
  return seconds.map((second) => Math.round(range.start + second * SECOND));
}

/** Silences of a source range, in source time. */
export async function findPauses(
  materialId: string,
  range: TimeRange,
  minSeconds: number,
): Promise<{ start: number; end: number }[] | null> {
  const clip = await clipChannels(materialId, range);
  if (!clip) return null;
  const pauses = await runAudioJob<Pause[]>({ kind: "pauses", ...clip, minSeconds });
  return pauses.map(({ start, end }) => ({
    start: Math.round(range.start + start * SECOND),
    end: Math.round(range.start + end * SECOND),
  }));
}

/** Whole silences of a source range, in source time. Audio is read in windows, so the last one can stop just short of the end. */
export async function findSilences(
  materialId: string,
  range: TimeRange,
  minSeconds: number,
): Promise<{ start: number; end: number }[] | null> {
  const clip = await clipChannels(materialId, range);
  if (!clip) return null;
  const silences = await runAudioJob<Pause[]>({ kind: "silences", ...clip, minSeconds });
  const last = range.start + range.duration;
  return silences.map(({ start, end }) => {
    const until = Math.round(range.start + end * SECOND);
    return {
      start: Math.round(range.start + start * SECOND),
      end: last - until < WINDOW_SECONDS * SECOND ? last : until,
    };
  });
}

function stretches(event: AudioEvent): boolean {
  return event.keepPitch && Math.abs(event.rate - 1) > RATE_TOLERANCE;
}

/** Identifies the result for a whole clip, so playing from its middle reuses it. Null if none is needed. */
function processingKey(event: AudioEvent): string | null {
  if (!stretches(event) && !event.denoise && !event.reversed) return null;
  const { materialId, source, length, rate, denoise, reversed } = event;
  return [materialId, source.start, source.duration, length, stretches(event) ? rate : 1, denoise, reversed].join(":");
}

/** The prepared audio for an event, and the rate to play it at. Null means use the original. */
export function processedAudio(event: AudioEvent): { buffer: AudioBuffer; rate: number } | null {
  const key = processingKey(event);
  const buffer = key ? processed.get(key) : undefined;
  return buffer ? { buffer, rate: stretches(event) ? 1 : event.rate } : null;
}

export function audioIsReady(events: AudioEvent[]): boolean {
  return events.every((event) => {
    const key = processingKey(event);
    return !key || processed.has(key) || !pool.hasSound(event.materialId);
  });
}

async function processClip(key: string, event: AudioEvent): Promise<void> {
  const clip = await clipChannels(event.materialId, event.source);
  if (!clip) return;
  const { sampleRate } = clip;
  const outputLength = Math.round((event.length / SECOND) * sampleRate);
  const channels = await runAudioJob<Float32Array[]>({
    kind: "process",
    channels: clip.channels,
    rate: stretches(event) ? event.rate : null,
    outputLength,
    denoise: event.denoise,
    reversed: event.reversed,
  });
  const buffer = new AudioBuffer({
    length: Math.max(1, channels[0]?.length ?? 1),
    numberOfChannels: channels.length,
    sampleRate,
  });
  channels.forEach((channel, index) => buffer.copyToChannel(channel as Float32Array<ArrayBuffer>, index));
  processed.set(key, buffer);
}

function dropUnused(active: Set<string>): void {
  for (const key of processed.keys()) {
    if (processed.size <= MAX_PROCESSED) return;
    if (!active.has(key)) processed.delete(key);
  }
}

/** Prepares every clip in a plan. A clip that fails plays as the original. Says if anything changed. */
export async function prepareAudio(events: AudioEvent[]): Promise<boolean> {
  const active = new Set<string>();
  let changed = false;
  await Promise.all(
    events.map(async (event) => {
      const key = processingKey(event);
      if (!key) return;
      active.add(key);
      if (processed.has(key)) return;
      let job = running.get(key);
      if (!job) {
        job = processClip(key, event)
          .catch((error) => console.warn("Não foi possível processar o áudio do clipe", error))
          .finally(() => running.delete(key));
        running.set(key, job);
      }
      await job;
      changed = true;
    }),
  );
  dropUnused(active);
  return changed;
}
