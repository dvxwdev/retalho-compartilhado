import { SECOND, projectDuration, type Project, type Us } from "../core/model";
import { audioPlan, resolveFrame, type Layer } from "../core/resolve";
import { readsInParts, scheduleAudio, scheduleParts } from "./audio";
import { drawFrame } from "./compositor";
import { pool, waitForSeek } from "./media";

const DRIFT_LIMIT_SECONDS = 0.12;
const PRELOAD_AHEAD: Us = 800_000;
const REVERSE_STEP_SECONDS = 0.04;
/** Sound kept on disk is read this far at a time, and asked for this early. */
const PART_SECONDS = 10;
const PART_LEAD_SECONDS = 3;

export function videoOf(layer: Layer): HTMLVideoElement | null {
  return layer.material.kind === "video" ? pool.videoFor(layer.segment.id, layer.material) : null;
}

/** Seeks every video layer so the next draw shows the exact frame. */
export async function prepareExactFrame(layers: Layer[]): Promise<void> {
  await Promise.all(
    layers.map(async (layer) => {
      const video = videoOf(layer);
      if (!video) return;
      if (!video.paused) video.pause();
      await waitForSeek(video, layer.sourceTime / SECOND);
    }),
  );
}

interface PlayerHost {
  project(): Project;
  playhead(): Us;
  setPlayhead(time: Us): void;
  setPlaying(playing: boolean): void;
}

/** Live playback clock. While paused it renders exact frames, latest request wins. */
export class Player {
  private canvas: HTMLCanvasElement | null = null;
  private context: CanvasRenderingContext2D | null = null;
  private audioContext: AudioContext | null = null;
  private master: GainNode | null = null;
  private sources: AudioBufferSourceNode[] = [];
  private audioRun = 0;
  private frameRequest = 0;
  private renderToken = 0;
  private startedAt = 0;
  private startedFrom: Us = 0;
  private running = false;

  constructor(private host: PlayerHost) {}

  attach(canvas: HTMLCanvasElement | null): void {
    this.canvas = canvas;
    this.context = canvas?.getContext("2d") ?? null;
    void this.renderStill();
  }

  get isPlaying(): boolean {
    return this.running;
  }

  private draw(layers: Layer[]): void {
    if (!this.canvas || !this.context) return;
    drawFrame(this.context, this.canvas.width, this.canvas.height, this.host.project(), layers);
  }

  async renderStill(): Promise<void> {
    if (this.running) return;
    const token = ++this.renderToken;
    const project = this.host.project();
    const layers = resolveFrame(project, this.host.playhead());
    await prepareExactFrame(layers);
    if (token === this.renderToken && !this.running) this.draw(layers);
  }

  private startAudio(from: Us): void {
    this.audioContext ??= new AudioContext({ sampleRate: 48000 });
    const context = this.audioContext;
    void context.resume();
    this.master = context.createGain();
    this.master.connect(context.destination);
    const project = this.host.project();
    const origin = context.currentTime + 0.05;
    const events = audioPlan(project, from).filter((event) => !readsInParts(event));
    this.sources = scheduleAudio(context, this.master, events, from, origin);
    void this.playParts(context, project, from, origin, ++this.audioRun);
  }

  /** Keeps reading ahead of the clock until playback stops or the timeline ends. */
  private async playParts(context: AudioContext, project: Project, from: Us, origin: number, run: number): Promise<void> {
    const duration = projectDuration(project);
    for (let done = 0; from + done * SECOND < duration; done += PART_SECONDS) {
      const master = this.master;
      if (run !== this.audioRun || !master) return;
      const sources = await scheduleParts(context, master, project, from + done * SECOND, origin + done, PART_SECONDS);
      if (run !== this.audioRun) {
        for (const source of sources) source.disconnect();
        return;
      }
      this.sources.push(...sources);
      const nextPart = origin + done + PART_SECONDS - PART_LEAD_SECONDS;
      const wait = (nextPart - context.currentTime) * 1000;
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }

  private stopAudio(): void {
    this.audioRun += 1;
    for (const source of this.sources) {
      try {
        source.stop();
      } catch {
        // Already finished.
      }
    }
    this.sources = [];
    this.master?.disconnect();
    this.master = null;
  }

  play(): void {
    if (this.running) return;
    const project = this.host.project();
    const duration = projectDuration(project);
    if (duration === 0) return;
    const from = this.host.playhead() >= duration ? 0 : this.host.playhead();
    this.running = true;
    this.host.setPlaying(true);
    this.startedFrom = from;
    this.startedAt = performance.now();
    this.startAudio(from);
    this.frameRequest = requestAnimationFrame(this.tick);
  }

  pause(): void {
    if (!this.running) return;
    this.running = false;
    cancelAnimationFrame(this.frameRequest);
    this.stopAudio();
    pool.pauseExcept(new Set());
    this.host.setPlaying(false);
    void this.renderStill();
  }

  toggle(): void {
    if (this.running) this.pause();
    else this.play();
  }

  seek(time: Us): void {
    const wasPlaying = this.running;
    if (wasPlaying) this.pause();
    this.host.setPlayhead(Math.max(0, time));
    if (wasPlaying) this.play();
    else void this.renderStill();
  }

  /** Reschedules sound after an edit made during playback. */
  projectChanged(): void {
    if (!this.running) {
      void this.renderStill();
      return;
    }
    this.stopAudio();
    const now = this.host.playhead();
    this.startedFrom = now;
    this.startedAt = performance.now();
    this.startAudio(now);
  }

  private tick = (): void => {
    if (!this.running) return;
    const project = this.host.project();
    const time = this.startedFrom + (performance.now() - this.startedAt) * 1000;
    if (time >= projectDuration(project)) {
      this.host.setPlayhead(projectDuration(project));
      this.pause();
      return;
    }
    this.host.setPlayhead(Math.round(time));

    const layers = resolveFrame(project, time);
    const active = new Set<string>();
    for (const layer of layers) {
      const video = videoOf(layer);
      if (!video) continue;
      active.add(layer.segment.id);
      const wanted = layer.sourceTime / SECOND;
      video.playbackRate = layer.segment.speed;
      // A video element cannot play backwards, so a reversed clip is stepped through instead.
      const limit = layer.segment.reversed ? REVERSE_STEP_SECONDS : DRIFT_LIMIT_SECONDS;
      if (Math.abs(video.currentTime - wanted) > limit) video.currentTime = wanted;
      if (layer.segment.frozen || layer.segment.reversed) {
        if (!video.paused) video.pause();
      } else if (video.paused) {
        void video.play().catch(() => undefined);
      }
    }
    for (const layer of resolveFrame(project, time + PRELOAD_AHEAD)) {
      const video = videoOf(layer);
      if (!video || active.has(layer.segment.id)) continue;
      active.add(layer.segment.id);
      const wanted = layer.segment.source.start / SECOND;
      if (Math.abs(video.currentTime - wanted) > DRIFT_LIMIT_SECONDS) video.currentTime = wanted;
    }
    pool.pauseExcept(active);
    this.draw(layers);
    this.frameRequest = requestAnimationFrame(this.tick);
  };
}
