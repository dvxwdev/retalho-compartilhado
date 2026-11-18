import { SECOND, type MediaMaterial, type TimeRange, type Us } from "../core/model";
import { frameDifference, pickCuts } from "../core/scenes";
import { pool, waitForSeek } from "./media";

const THUMB_WIDTH = 32;
const THUMB_HEIGHT = 18;
const SAMPLE_SECONDS = 0.25;
const MAX_SAMPLES = 2400;
const REFINE_LIMIT_SECONDS = 0.02;

/** Hard cuts in a source range, in source time, narrowed down to about one frame. */
export async function findSceneCuts(
  material: MediaMaterial,
  range: TimeRange,
  onProgress: (fraction: number) => void,
): Promise<Us[]> {
  const url = pool.url(material.id);
  if (!url) return [];
  const video = document.createElement("video");
  video.muted = true;
  video.preload = "auto";
  video.src = url;
  await new Promise<void>((resolve, reject) => {
    video.onloadeddata = () => resolve();
    video.onerror = () => reject(new Error("Não foi possível ler o vídeo"));
  });

  const canvas = new OffscreenCanvas(THUMB_WIDTH, THUMB_HEIGHT);
  const context = canvas.getContext("2d", { willReadFrequently: true })!;
  const frameAt = async (seconds: number) => {
    await waitForSeek(video, seconds);
    context.drawImage(video, 0, 0, THUMB_WIDTH, THUMB_HEIGHT);
    return context.getImageData(0, 0, THUMB_WIDTH, THUMB_HEIGHT).data;
  };

  const start = range.start / SECOND;
  const seconds = range.duration / SECOND;
  const step = Math.max(SAMPLE_SECONDS, seconds / MAX_SAMPLES);
  const times: number[] = [];
  for (let time = start; time < start + seconds; time += step) times.push(time);

  const frames: Uint8ClampedArray[] = [];
  const differences: number[] = [];
  for (const [index, time] of times.entries()) {
    frames.push(await frameAt(time));
    if (index > 0) differences.push(frameDifference(frames[index - 1]!, frames[index]!));
    onProgress((index + 1) / times.length);
  }

  const cuts: Us[] = [];
  for (const index of pickCuts(differences)) {
    let before = times[index]!;
    let after = times[index + 1]!;
    const first = frames[index]!;
    const last = frames[index + 1]!;
    // Halving the gap finds the cut without decoding every frame between the samples.
    while (after - before > REFINE_LIMIT_SECONDS) {
      const middle = (before + after) / 2;
      const frame = await frameAt(middle);
      if (frameDifference(first, frame) < frameDifference(frame, last)) before = middle;
      else after = middle;
    }
    cuts.push(Math.round(after * SECOND));
  }
  video.removeAttribute("src");
  video.load();
  return cuts;
}
