import { SECOND, type TimeRange } from "../core/model";
import type { SpeechChunk } from "../core/speech";
import { pool } from "./media";
import type { SpeechMessage, SpeechModel, SpeechRequest } from "./whisper.worker";

const SPEECH_SAMPLE_RATE = 16000;
/** Long clips are converted in parts, to stay light on memory. */
const CONVERT_SECONDS = 60;

export type SpeechProgress =
  | { stage: "download"; fraction: number }
  | { stage: "working" };

let worker: Worker | null = null;
let cancelCurrent: (() => void) | null = null;

/** The clip as the model expects it: one channel at 16 kHz. */
async function speechAudio(materialId: string, range: TimeRange): Promise<Float32Array> {
  const audio = new Float32Array(Math.ceil((range.duration / SECOND) * SPEECH_SAMPLE_RATE));
  for (let done = 0; done < range.duration; done += CONVERT_SECONDS * SECOND) {
    const duration = Math.min(CONVERT_SECONDS * SECOND, range.duration - done);
    const part = await pool.readAudio(materialId, { start: range.start + done, duration });
    if (!part) throw new Error("O áudio deste clipe não está disponível.");
    const length = Math.ceil((duration / SECOND) * SPEECH_SAMPLE_RATE);
    const context = new OfflineAudioContext(1, length, SPEECH_SAMPLE_RATE);
    const source = context.createBufferSource();
    source.buffer = part;
    source.connect(context.destination);
    source.start();
    const rendered = (await context.startRendering()).getChannelData(0);
    audio.set(
      rendered.subarray(0, audio.length - Math.round((done / SECOND) * SPEECH_SAMPLE_RATE)),
      Math.round((done / SECOND) * SPEECH_SAMPLE_RATE),
    );
  }
  return audio;
}

export async function transcribe(
  materialId: string,
  range: TimeRange,
  model: SpeechModel,
  language: string | null,
  onProgress: (progress: SpeechProgress) => void,
): Promise<SpeechChunk[]> {
  const audio = await speechAudio(materialId, range);
  worker ??= new Worker(new URL("./whisper.worker.ts", import.meta.url), { type: "module" });
  const running = worker;
  const files = new Map<string, { loaded: number; total: number }>();

  return new Promise((resolve, reject) => {
    cancelCurrent = () => {
      // The model cannot be interrupted midway, so stopping means ending the worker.
      running.terminate();
      worker = null;
      cancelCurrent = null;
      reject(new DOMException("Transcrição cancelada", "AbortError"));
    };
    running.onmessage = ({ data }: MessageEvent<SpeechMessage>) => {
      if (data.type === "download") {
        files.set(data.file, { loaded: data.loaded, total: data.total });
        const all = [...files.values()];
        const total = all.reduce((sum, file) => sum + file.total, 0);
        const loaded = all.reduce((sum, file) => sum + file.loaded, 0);
        onProgress({ stage: "download", fraction: total ? loaded / total : 0 });
      } else if (data.type === "working") {
        onProgress({ stage: "working" });
      } else {
        cancelCurrent = null;
        if (data.type === "done") resolve(data.chunks);
        else reject(new Error(data.message));
      }
    };
    running.onerror = (event) => {
      cancelCurrent = null;
      worker = null;
      reject(new Error(event.message || "Não foi possível carregar o modelo de fala."));
    };
    const request: SpeechRequest = { audio, model, language };
    running.postMessage(request, [audio.buffer as ArrayBuffer]);
  });
}

export function cancelTranscription(): void {
  cancelCurrent?.();
}
