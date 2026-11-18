import { hasCurves, hasHsl } from "./curves";
import type { Adjust, Segment } from "./model";

export const EFFECT_TYPES = ["blur", "glow", "glitch", "pixelate", "shake", "retro"] as const;
export type EffectType = (typeof EFFECT_TYPES)[number];

/** Amounts from 0 to 1, one per effect that is on. */
export type Effects = Partial<Record<EffectType, number>>;

export interface Chroma {
  /** Hex colour to remove. */
  color: string;
  /** How far from that colour still counts as background, from 0 to 1. */
  strength: number;
  /** Width of the soft edge, from 0 to 1. */
  softness: number;
  /** How much of the colour's glow is removed from what remains, from 0 to 1. */
  spill: number;
}

export interface LutChoice {
  id: string;
  /** From 0, the original, to 1, the LUT in full. */
  strength: number;
}

/** Adjustments the 2D canvas filter cannot do. Brightness, contrast and saturation can. */
const GPU_ADJUSTMENTS: (keyof Adjust)[] = [
  "exposure",
  "temperature",
  "tint",
  "hue",
  "highlights",
  "shadows",
  "sharpen",
  "vignette",
  "grain",
  "fade",
];

/** Whether a clip's look has to go through the GPU; every other clip is drawn directly. */
export function needsGpu(segment: Segment): boolean {
  if (segment.chroma || segment.lut || hasHsl(segment.hsl) || hasCurves(segment.curves)) return true;
  if (Object.values(segment.effects ?? {}).some(Boolean)) return true;
  return GPU_ADJUSTMENTS.some((name) => Boolean(segment.adjust[name]));
}
