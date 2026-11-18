import { env, pipeline } from "@huggingface/transformers";
import runtimeUrl from "../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.mjs?url";
import runtimeBinaryUrl from "../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.wasm?url";
import type { SpeechChunk } from "../core/speech";

export type SpeechModel = "fast" | "accurate";

export interface SpeechRequest {
  audio: Float32Array;
  model: SpeechModel;
  /** Null lets the model detect it. */
  language: string | null;
}

export type SpeechMessage =
  | { type: "download"; file: string; loaded: number; total: number }
  | { type: "working" }
  | { type: "done"; chunks: SpeechChunk[] }
  | { type: "error"; message: string };

/** These variants also report where each word falls, which captions and cutting need. */
const MODELS: Record<SpeechModel, string> = {
  fast: "onnx-community/whisper-base_timestamped",
  accurate: "onnx-community/whisper-small_timestamped",
};

// The runtime ships with the app, so only the model itself ever comes from the network.
env.allowLocalModels = false;
env.backends.onnx!.wasm!.wasmPaths = { wasm: runtimeBinaryUrl, mjs: runtimeUrl };

const scope = self as unknown as Worker;

type Transcriber = (
  audio: Float32Array,
  options: Record<string, unknown>,
) => Promise<{ chunks?: SpeechChunk[] }>;

const loaded = new Map<SpeechModel, Promise<Transcriber>>();

/**
 * Runs on the processor. On an integrated GPU that measured faster than WebGPU,
 * and it keeps the download at the smaller 8-bit size.
 */
function load(model: SpeechModel): Promise<Transcriber> {
  let transcriber = loaded.get(model);
  if (!transcriber) {
    transcriber = pipeline("automatic-speech-recognition", MODELS[model], {
      device: "wasm",
      dtype: "q8",
      progress_callback: (event: { status: string; file?: string; loaded?: number; total?: number }) => {
        if (event.status !== "progress" || !event.file) return;
        const message: SpeechMessage = {
          type: "download",
          file: event.file,
          loaded: event.loaded ?? 0,
          total: event.total ?? 0,
        };
        scope.postMessage(message);
      },
    }) as unknown as Promise<Transcriber>;
    loaded.set(model, transcriber);
  }
  return transcriber;
}

self.onmessage = async ({ data }: MessageEvent<SpeechRequest>) => {
  try {
    const transcriber = await load(data.model);
    scope.postMessage({ type: "working" } satisfies SpeechMessage);
    const result = await transcriber(data.audio, {
      task: "transcribe",
      language: data.language,
      return_timestamps: "word",
      chunk_length_s: 30,
      stride_length_s: 5,
    });
    scope.postMessage({ type: "done", chunks: result.chunks ?? [] } satisfies SpeechMessage);
  } catch (error) {
    scope.postMessage({ type: "error", message: (error as Error).message } satisfies SpeechMessage);
  }
};
