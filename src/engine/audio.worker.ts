import { detectBeats } from "../core/beats";
import { reduceNoise } from "../core/denoise";
import { measureLoudness } from "../core/loudness";
import { detectPauses, detectSilences } from "../core/pauses";
import { timeStretch } from "../core/stretch";

export type AudioJob =
  | { kind: "loudness"; channels: Float32Array[] }
  | { kind: "beats"; channels: Float32Array[]; sampleRate: number }
  | { kind: "pauses"; channels: Float32Array[]; sampleRate: number; minSeconds: number }
  | { kind: "silences"; channels: Float32Array[]; sampleRate: number; minSeconds: number }
  | { kind: "process"; channels: Float32Array[]; rate: number | null; outputLength: number; denoise: number; reversed: boolean };

export interface AudioJobRequest {
  id: number;
  job: AudioJob;
}

function runJob(job: AudioJob): { result: unknown; transfer: Transferable[] } {
  if (job.kind === "loudness") return { result: measureLoudness(job.channels), transfer: [] };
  if (job.kind === "silences") {
    return { result: detectSilences(job.channels, job.sampleRate, job.minSeconds), transfer: [] };
  }
  if (job.kind === "pauses") {
    return { result: detectPauses(job.channels, job.sampleRate, job.minSeconds), transfer: [] };
  }
  if (job.kind === "beats") return { result: detectBeats(job.channels, job.sampleRate), transfer: [] };
  const cleaned = job.denoise ? reduceNoise(job.channels, job.denoise) : job.channels;
  const ordered = job.reversed ? cleaned.map((channel) => channel.slice().reverse()) : cleaned;
  const channels = job.rate ? timeStretch(ordered, job.rate, job.outputLength) : ordered;
  return { result: channels, transfer: channels.map((channel) => channel.buffer as ArrayBuffer) };
}

/** Heavy audio maths runs here, so the editor keeps responding while it works. */
self.onmessage = ({ data: { id, job } }: MessageEvent<AudioJobRequest>) => {
  const scope = self as unknown as Worker;
  try {
    const { result, transfer } = runJob(job);
    scope.postMessage({ id, result }, transfer);
  } catch (error) {
    scope.postMessage({ id, error: (error as Error).message });
  }
};
