import { EFFECT_TYPES, type EffectType } from "./look";
import {
  ANIMATABLE,
  type AnimatableProp,
  type Easing,
  type KeyedProp,
  type Keyframe,
  type Segment,
  type Transform,
  type Us,
} from "./model";

/** Linear pieces that replace a curve cut in the middle, since its shape cannot be cut. */
const BAKE_STEPS = 8;

/** Falls and rebounds three times, each smaller than the last. */
function bounced(t: number): number {
  const strength = 7.5625;
  if (t < 1 / 2.75) return strength * t * t;
  if (t < 2 / 2.75) return strength * (t - 1.5 / 2.75) ** 2 + 0.75;
  if (t < 2.5 / 2.75) return strength * (t - 2.25 / 2.75) ** 2 + 0.9375;
  return strength * (t - 2.625 / 2.75) ** 2 + 0.984375;
}

function eased(ease: Easing | undefined, t: number): number {
  switch (ease) {
    case "in":
      return t ** 3;
    case "out":
      return 1 - (1 - t) ** 3;
    case "inOut":
      return t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2;
    case "hold":
      return t < 1 ? 0 : 1;
    case "back":
      return 1 + 2.70158 * (t - 1) ** 3 + 1.70158 * (t - 1) ** 2;
    case "elastic":
      if (t <= 0 || t >= 1) return t;
      return 2 ** (-10 * t) * Math.sin(((t * 10 - 0.75) * 2 * Math.PI) / 3) + 1;
    case "bounce":
      return bounced(t);
    default:
      return t;
  }
}

/** Follows each keyframe's easing, and holds flat outside the keyframes. */
export function sampleKeyframes(keyframes: Keyframe[], offset: Us): number {
  const first = keyframes[0]!;
  if (offset <= first.offset) return first.value;
  for (let index = 1; index < keyframes.length; index += 1) {
    const next = keyframes[index]!;
    if (offset <= next.offset) {
      const previous = keyframes[index - 1]!;
      const span = next.offset - previous.offset;
      if (span <= 0) return next.value;
      const progress = eased(previous.ease, (offset - previous.offset) / span);
      return previous.value + (next.value - previous.value) * progress;
    }
  }
  return keyframes[keyframes.length - 1]!.value;
}

const isTransform = (prop: KeyedProp): prop is AnimatableProp => (ANIMATABLE as readonly string[]).includes(prop);
const isEffect = (prop: KeyedProp): prop is EffectType => (EFFECT_TYPES as readonly string[]).includes(prop);

export function keyedProps(segment: Segment): KeyedProp[] {
  return Object.keys(segment.keyframes) as KeyedProp[];
}

/** Whether the clip's placement is animated, as opposed to its colour or effects. */
export function hasMoveKeys(segment: Segment): boolean {
  return keyedProps(segment).some(isTransform);
}

export function hasAdjustKeys(segment: Segment): boolean {
  return keyedProps(segment).some((prop) => !isTransform(prop) && !isEffect(prop));
}

function baseValue(segment: Segment, prop: KeyedProp): number {
  if (isTransform(prop)) return segment.transform[prop];
  if (isEffect(prop)) return segment.effects?.[prop] ?? 0;
  return segment.adjust[prop] ?? 0;
}

/** The value a property has when it is not animated. */
export function writeBase(segment: Segment, prop: KeyedProp, value: number): void {
  if (isTransform(prop)) segment.transform[prop] = value;
  else if (isEffect(prop)) segment.effects = { ...segment.effects, [prop]: value };
  else segment.adjust[prop] = value;
}

export function sampleProp(segment: Segment, prop: KeyedProp, offset: Us): number {
  const keyframes = segment.keyframes[prop];
  return keyframes?.length ? sampleKeyframes(keyframes, offset) : baseValue(segment, prop);
}

/** The clip with its animated colour and effects as they are at this moment. */
export function sampledLook(segment: Segment, offset: Us): Segment {
  const props = keyedProps(segment).filter((prop) => !isTransform(prop));
  if (props.length === 0) return segment;
  const adjust = { ...segment.adjust };
  const effects = { ...segment.effects };
  for (const prop of props) {
    const value = sampleProp(segment, prop, offset);
    if (isEffect(prop)) effects[prop] = value;
    else adjust[prop as keyof typeof adjust] = value;
  }
  return { ...segment, adjust, effects };
}

export function sampleTransform(segment: Segment, offset: Us): Transform {
  const result = { ...segment.transform };
  for (const prop of ANIMATABLE) result[prop] = sampleProp(segment, prop, offset);
  return result;
}

export function upsertKeyframe(keyframes: Keyframe[], offset: Us, value: number): Keyframe[] {
  const existing = keyframes.find((keyframe) => keyframe.offset === offset);
  const others = keyframes.filter((keyframe) => keyframe !== existing);
  return [...others, { ...existing, offset, value }].sort((a, b) => a.offset - b.offset);
}

/**
 * Keeps the part of a curve inside [from, to] and rebases it to from. Boundary
 * keyframes are inserted so the kept part animates as it did before. An eased
 * span cut in the middle is rebuilt from samples, because its easing would
 * otherwise restart from the cut.
 */
export function sliceKeyframes(keyframes: Keyframe[], from: Us, to: Us): Keyframe[] {
  if (keyframes.length === 0) return [];
  const last = keyframes[keyframes.length - 1]!;
  const edges = [
    from,
    ...keyframes.filter(({ offset }) => offset > from && offset < to).map(({ offset }) => offset),
    to,
  ];
  const points: Keyframe[] = [];
  for (let index = 0; index < edges.length - 1; index += 1) {
    const start = edges[index]!;
    const end = edges[index + 1]!;
    const owner = keyframes.findLast(({ offset }) => offset <= start);
    const ease = owner && owner !== last ? owner.ease : undefined;
    const whole = owner?.offset === start && keyframes.some(({ offset }) => offset === end);
    const value = sampleKeyframes(keyframes, start);
    if (!ease) {
      points.push({ offset: start, value });
    } else if (whole || ease === "hold") {
      points.push({ offset: start, value, ease });
    } else {
      for (let step = 0; step < BAKE_STEPS; step += 1) {
        const offset = Math.round(start + ((end - start) * step) / BAKE_STEPS);
        points.push({ offset, value: sampleKeyframes(keyframes, offset) });
      }
    }
  }
  points.push({ offset: to, value: sampleKeyframes(keyframes, to) });
  return points.map((keyframe) => ({ ...keyframe, offset: keyframe.offset - from }));
}
