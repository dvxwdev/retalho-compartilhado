import type { Us } from "./model";

export const LETTER_ANIMATIONS = ["fade", "rise", "drop", "slide", "pop", "spin", "wave"] as const;
export type LetterAnimationType = (typeof LETTER_ANIMATIONS)[number];

export const LETTER_ORDERS = ["forward", "reverse", "center", "random"] as const;
export type LetterOrder = (typeof LETTER_ORDERS)[number];

export interface LetterAnimation {
  type: LetterAnimationType;
  order: LetterOrder;
  /** How long each letter takes. */
  duration: Us;
  /** Time between one letter starting and the next. */
  stagger: Us;
}

export interface LetterState {
  opacity: number;
  /** In font sizes, so the move fits any text. */
  x: number;
  y: number;
  scale: number;
  /** Degrees. */
  rotation: number;
}

const AT_REST: LetterState = { opacity: 1, x: 0, y: 0, scale: 1, rotation: 0 };
const TRAVEL = 0.9;
const WAVE_HEIGHT = 0.18;

const easeOut = (t: number) => 1 - (1 - t) ** 3;

function overshoot(t: number): number {
  return 1 + 2.70158 * (t - 1) ** 3 + 1.70158 * (t - 1) ** 2;
}

/** A shuffled but repeatable position, so every frame agrees on the order. */
function scattered(index: number, total: number): number {
  const noise = Math.sin(index * 12.9898 + 4.1414) * 43758.5453;
  return Math.floor((noise - Math.floor(noise)) * total);
}

function turn(order: LetterOrder, index: number, total: number): number {
  switch (order) {
    case "reverse":
      return total - 1 - index;
    case "center":
      return Math.abs(index - (total - 1) / 2);
    case "random":
      return scattered(index, total);
    default:
      return index;
  }
}

/** How a letter looks at a time since the clip began. Pure, so preview and export agree. */
export function letterState(animation: LetterAnimation, index: number, total: number, time: Us): LetterState {
  const started = time - turn(animation.order, index, total) * animation.stagger;
  if (animation.type === "wave") {
    return { ...AT_REST, y: -Math.sin((started / Math.max(1, animation.duration)) * Math.PI * 2) * WAVE_HEIGHT };
  }
  const progress = Math.min(1, Math.max(0, started / Math.max(1, animation.duration)));
  if (progress >= 1) return AT_REST;
  const away = 1 - easeOut(progress);
  const opacity = Math.min(1, progress * 2.5);
  switch (animation.type) {
    case "rise":
      return { ...AT_REST, opacity, y: away * TRAVEL };
    case "drop":
      return { ...AT_REST, opacity, y: -away * TRAVEL };
    case "slide":
      return { ...AT_REST, opacity, x: away * TRAVEL };
    case "pop":
      return { ...AT_REST, opacity, scale: Math.max(0, overshoot(progress)) };
    case "spin":
      return { ...AT_REST, opacity, rotation: away * 180, scale: easeOut(progress) };
    default:
      return { ...AT_REST, opacity: easeOut(progress) };
  }
}
