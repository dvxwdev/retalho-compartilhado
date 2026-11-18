import { SECOND, type Us } from "../core/model";

export function formatTime(time: Us, fps: number): string {
  const totalFrames = Math.round((time / SECOND) * fps);
  const frames = totalFrames % fps;
  const seconds = Math.floor(totalFrames / fps);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(Math.floor(seconds / 60))}:${pad(seconds % 60)}:${pad(frames)}`;
}

export function formatDuration(time: Us): string {
  const seconds = time / SECOND;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  return `${Math.floor(seconds / 60)}m${String(Math.round(seconds % 60)).padStart(2, "0")}s`;
}
