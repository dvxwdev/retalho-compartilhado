import type { Segment, Transform, Us } from "./model";

export const ENTRANCE_TYPES = ["fade", "rise", "drop", "left", "right", "zoom", "pop", "type", "draw"] as const;
export const EXIT_TYPES = ["fade", "rise", "drop", "left", "right", "zoom"] as const;
export const LOOP_TYPES = ["pulse", "float", "shake"] as const;

export type EntranceType = (typeof ENTRANCE_TYPES)[number];
export type ExitType = (typeof EXIT_TYPES)[number];
export type LoopType = (typeof LOOP_TYPES)[number];

export interface ClipAnimation<T> {
  type: T;
  /** Length of an entrance or exit, or of one cycle of a loop. */
  duration: Us;
}

export interface Animated {
  transform: Transform;
  /** Fraction of the text typed, or of a shape's outline drawn. */
  reveal: number;
}

/** Fractions of half the canvas, like Transform.x and y. */
const TRAVEL_Y = 0.25;
const TRAVEL_X = 0.4;
const ZOOM_START = 0.5;
const POP_FADE_SPEED = 3;
const PULSE_AMOUNT = 0.05;
const FLOAT_AMOUNT = 0.02;
const SHAKE_AMOUNT = 0.008;
const SHAKE_CYCLES_PER_LOOP = 3;

const easeOut = (t: number) => 1 - (1 - t) ** 3;

/** Overshoots past 1 before settling. */
function easeBack(t: number): number {
  const overshoot = 1.70158;
  return 1 + (overshoot + 1) * (t - 1) ** 3 + overshoot * (t - 1) ** 2;
}

/** Moves a transform away from rest. Progress 1 is at rest, 0 is fully away. */
function offsetFrom(transform: Transform, type: EntranceType | ExitType, progress: number, leaving: boolean): void {
  const away = 1 - easeOut(progress);
  const vertical = leaving ? 1 : -1;
  switch (type) {
    case "rise":
      transform.y += vertical * away * TRAVEL_Y;
      break;
    case "drop":
      transform.y -= vertical * away * TRAVEL_Y;
      break;
    case "left":
      transform.x -= away * TRAVEL_X;
      break;
    case "right":
      transform.x += away * TRAVEL_X;
      break;
    case "zoom":
      transform.scale *= ZOOM_START + (1 - ZOOM_START) * (1 - away);
      break;
    default:
      return;
  }
}

function applyLoop(transform: Transform, type: LoopType, cycle: number): void {
  const wave = Math.sin(cycle * 2 * Math.PI);
  if (type === "pulse") transform.scale *= 1 + PULSE_AMOUNT * wave;
  if (type === "float") transform.y += FLOAT_AMOUNT * wave;
  if (type === "shake") transform.x += SHAKE_AMOUNT * Math.sin(cycle * 2 * Math.PI * SHAKE_CYCLES_PER_LOOP);
}

/**
 * Applies a clip's animations to its transform at an offset. Pure and driven by
 * the offset alone, so preview and export agree on every frame. When entrance
 * and exit do not both fit, they shrink together.
 */
export function animate(segment: Segment, base: Transform, offset: Us): Animated {
  const transform = { ...base };
  let reveal = 1;
  const { animIn, animOut, animLoop } = segment;
  const total = segment.target.duration;
  const fit = Math.min(1, total / Math.max(1, (animIn?.duration ?? 0) + (animOut?.duration ?? 0)));

  if (animLoop && animLoop.duration > 0) applyLoop(transform, animLoop.type, offset / animLoop.duration);

  if (animIn && animIn.duration > 0) {
    const progress = Math.min(1, offset / (animIn.duration * fit));
    if (animIn.type === "type" || animIn.type === "draw") {
      reveal = progress;
    } else if (animIn.type === "pop") {
      transform.scale *= easeBack(progress);
      transform.opacity *= Math.min(1, progress * POP_FADE_SPEED);
    } else {
      offsetFrom(transform, animIn.type, progress, false);
      transform.opacity *= easeOut(progress);
    }
  }

  if (animOut && animOut.duration > 0) {
    const progress = Math.min(1, (total - offset) / (animOut.duration * fit));
    offsetFrom(transform, animOut.type, progress, true);
    transform.opacity *= easeOut(progress);
  }

  return { transform, reveal };
}
