import type { ClipAnimation, EntranceType, ExitType, LoopType } from "./animation";
import type { Curves, HslAdjust } from "./curves";
import type { LetterAnimation } from "./letters";
import type { Chroma, EffectType, Effects, LutChoice } from "./look";
import type { SpokenStyle, Word } from "./speech";

/**
 * Project model. Times are integer microseconds. A material is the reusable
 * asset, a segment is one placement of a material on a track, so splitting a
 * clip duplicates a segment and never the media.
 */
export type Us = number;

export const SECOND: Us = 1_000_000;

export interface TimeRange {
  start: Us;
  duration: Us;
}

export type MediaKind = "video" | "image" | "audio";

export interface MediaMaterial {
  id: string;
  kind: MediaKind;
  name: string;
  duration: Us;
  width: number;
  height: number;
  hasAudio: boolean;
  /** Set while the source file is not in the media store (imported drafts). */
  offline?: boolean;
}

export interface TextShadow {
  color: string;
  /** Same unit as fontSize. */
  blur: number;
  distance: number;
  /** Degrees, clockwise from the right. */
  angle: number;
}

export interface TextMaterial {
  id: string;
  kind: "text";
  text: string;
  fontFamily: string;
  /** Pixels on a canvas whose short side is 1080. */
  fontSize: number;
  color: string;
  bold: boolean;
  italic: boolean;
  align: "left" | "center" | "right";
  strokeColor: string;
  /** Same unit as fontSize; 0 disables the outline. */
  strokeWidth: number;
  /** Empty string disables the background box. */
  background: string;
  /** Space between the text and the edge of its background, in font sizes. Defaults to 0.25; top and bottom get half. */
  backgroundPadding?: number;
  /** Corner rounding of the background, from 0, square, to 1, fully round ends. */
  backgroundRadius?: number;
  /** Extra space between letters, same unit as fontSize. */
  letterSpacing?: number;
  /** Line distance as a multiple of the font size. */
  lineHeight?: number;
  /** Degrees of arc the text bends through; positive arches upward. */
  curve?: number;
  shadow?: TextShadow;
  /** When each word is said, from the start of the source, for captions made from speech. */
  timing?: Word[];
  /** How the word being said stands out. */
  spoken?: SpokenStyle;
}

export type ShapeKind = "rectangle" | "circle" | "triangle" | "star" | "heart" | "line";

export interface ShapeMaterial {
  id: string;
  kind: "shape";
  shape: ShapeKind;
  /** Empty string leaves the inside clear. */
  fill: string;
  /** A second colour turns the fill into a gradient. */
  fill2: string;
  /** Degrees, clockwise from pointing right. */
  gradientAngle: number;
  stroke: string;
  /** Same unit as fontSize; 0 disables the outline. */
  strokeWidth: number;
  /** Corner rounding of a rectangle, as a fraction of its short side. */
  radius: number;
  /** Fractions of the canvas's short side. */
  width: number;
  height: number;
}

/** Shows nothing itself: its colour and effects apply to everything below it. */
export interface AdjustmentMaterial {
  id: string;
  kind: "adjustment";
}

export type Material = MediaMaterial | TextMaterial | ShapeMaterial | AdjustmentMaterial;

export function isMediaMaterial(material: Material): material is MediaMaterial {
  return material.kind !== "text" && material.kind !== "shape" && material.kind !== "adjustment";
}

export type TrackType = "video" | "text" | "audio";

export const ANIMATABLE = ["x", "y", "scale", "rotation", "opacity"] as const;
export type AnimatableProp = (typeof ANIMATABLE)[number];

/** x and y are fractions of half the canvas, +y up; scale 1 fits the canvas. */
export type Transform = Record<AnimatableProp, number>;

/** Everything a keyframe can drive: placement, colour adjustments and effect amounts. */
export type KeyedProp = AnimatableProp | keyof Adjust | EffectType;

/** Shape of the move from a keyframe to the next one; without one it is a straight line. */
export type Easing = "in" | "out" | "inOut" | "hold" | "back" | "elastic" | "bounce";

export interface Keyframe {
  /** Offset from the segment start, on the timeline clock. */
  offset: Us;
  value: number;
  ease?: Easing;
}

export interface Adjust {
  /** All in -100..100, 0 is neutral. */
  brightness: number;
  contrast: number;
  saturation: number;
  exposure?: number;
  temperature?: number;
  tint?: number;
  hue?: number;
  highlights?: number;
  shadows?: number;
  /** These four run from 0 up, except vignette, where a negative value lightens the corners. */
  sharpen?: number;
  vignette?: number;
  grain?: number;
  fade?: number;
}

/** Values are canvas composite operations; a segment without one blends normally. */
export type BlendMode =
  | "multiply"
  | "screen"
  | "overlay"
  | "darken"
  | "lighten"
  | "color-dodge"
  | "color-burn"
  | "hard-light"
  | "soft-light"
  | "difference"
  | "exclusion";

export type TransitionType = "fade" | "dip" | "slide" | "wipe" | "push" | "zoom" | "spin" | "iris";

export interface Transition {
  type: TransitionType;
  duration: Us;
}

export type MaskShape = "linear" | "rectangle" | "circle" | "heart" | "star";

/** Lives on the clip, so it moves, turns and scales with it. */
export interface Mask {
  shape: MaskShape;
  /** Centre as fractions of half the clip, +y up, like Transform. */
  x: number;
  y: number;
  /** Fractions of the clip size. A linear mask ignores them. */
  width: number;
  height: number;
  /** Degrees, clockwise. */
  rotation: number;
  /** Width of the soft edge, as a fraction of the clip's short side. */
  feather: number;
  invert: boolean;
}

/** Sound shaping on a clip. Bands are in decibels, from -12 to 12. */
export interface AudioEffects {
  low: number;
  mid: number;
  high: number;
  /** Evens out loud and quiet moments. */
  compressor: boolean;
  /** Amount of room echo, from 0 to 1. */
  reverb: number;
}

/** Finish around a video or image. */
export interface ClipFrame {
  /** Fraction of the clip's short side. */
  radius: number;
  strokeColor: string;
  /** Fraction of the clip's short side; 0 disables the outline. */
  strokeWidth: number;
  /** Empty string disables the shadow. */
  shadowColor: string;
  /** Fraction of the clip's short side. */
  shadowSize: number;
}

/** What was measured in a clip's source, in source time, so it survives cuts and speed changes. */
export interface Analise {
  versao: 1;
  /** ISO 8601. */
  geradoEm: string;
  /** Scene changes. */
  cenas?: Us[];
  /** Whole silences as measured; the margin kept around words is applied when cutting. */
  pausas?: { inicio: Us; fim: Us }[];
  /** Mirrors beats, which stays for saved projects. */
  batidas?: Us[];
  /** LUFS and peak in dBFS. */
  loudness?: { integrado: number; pico: number };
}

/** Fractions of the source removed from each edge. */
export type Crop = Record<"left" | "top" | "right" | "bottom", number>;

/** How a video or image meets the canvas: whole inside it, or filling it with the overflow cut off. */
export type Fit = "contain" | "cover";

export interface Segment {
  id: string;
  materialId: string;
  /** Absent means contain, as in projects saved before this existed. */
  fit?: Fit;
  /** Position on the timeline. */
  target: TimeRange;
  /** Range read from the material. Text and images ignore it for time lookup. */
  source: TimeRange;
  speed: number;
  /** 1 is unity gain; values above 1 amplify. */
  volume: number;
  /** Stereo position from -1, left, to 1, right. */
  pan?: number;
  /** In source time, so they stay on the sound through trims, splits and speed changes. */
  beats?: Us[];
  /** What is said in the clip, also in source time. */
  words?: Word[];
  analise?: Analise;
  /** Stretches of this clip to play quieter, from its own start, so voices come through. */
  ducking?: { ranges: { start: Us; end: Us }[]; amount: number };
  audioEffects?: AudioEffects;
  /** Noise reduction from 0, off, to 1, the most. */
  denoise?: number;
  /** Lets a speed change alter the pitch too, like a tape. By default the pitch stays. */
  changePitch?: boolean;
  fadeIn: Us;
  fadeOut: Us;
  transform: Transform;
  adjust: Adjust;
  keyframes: Partial<Record<KeyedProp, Keyframe[]>>;
  /** Plays across the cut into the next adjacent segment on the track. */
  transitionOut: Transition | null;
  /** Clips sharing this id are selected and moved together. */
  group?: string;
  /** Shows source.start for its whole length, silently. */
  frozen?: boolean;
  /** Plays the source range backwards. */
  reversed?: boolean;
  flipX?: boolean;
  flipY?: boolean;
  blend?: BlendMode;
  animIn?: ClipAnimation<EntranceType>;
  animOut?: ClipAnimation<ExitType>;
  animLoop?: ClipAnimation<LoopType>;
  /** Moves the letters of a text one by one. */
  letters?: LetterAnimation;
  crop?: Crop;
  frame?: ClipFrame;
  mask?: Mask;
  /** Shows the layer below only through this layer's shape, as a track matte. */
  matte?: boolean;
  chroma?: Chroma;
  hsl?: HslAdjust;
  curves?: Curves;
  lut?: LutChoice;
  effects?: Effects;
}

export interface Track {
  id: string;
  type: TrackType;
  name: string;
  muted: boolean;
  hidden: boolean;
  /** Refuses every edit to its clips. Absent in projects saved before this existed. */
  locked?: boolean;
  /** Sorted by target.start and never overlapping. */
  segments: Segment[];
}

/** What shows where no clip covers the canvas. Without one it is black. */
export type CanvasBackground =
  | { kind: "color"; color: string }
  /** A blurred copy of the bottom clip. Amount is in pixels on a canvas whose short side is 1080. */
  | { kind: "blur"; amount: number }
  | { kind: "image"; materialId: string };

export interface Marker {
  id: string;
  /** Timeline time. A marker stays put when clips around it move. */
  time: Us;
  label: string;
  color: string;
}

export interface Project {
  format: "retalho";
  version: 1;
  id: string;
  name: string;
  fps: number;
  canvas: { width: number; height: number };
  materials: Record<string, Material>;
  /** Earlier tracks draw first; text tracks always draw above video tracks. */
  tracks: Track[];
  /** Sorted by time. Absent in projects saved before this existed. */
  markers?: Marker[];
  background?: CanvasBackground;
  /** Imported colour tables by id. The tables live with the media, to keep edits light. */
  luts?: Record<string, { id: string; name: string }>;
  /** Imported fonts by id. The name is the family that texts ask for. */
  fonts?: Record<string, { id: string; name: string }>;
}

export const DEFAULT_TRANSFORM: Transform = { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 };
export const DEFAULT_ADJUST: Adjust = { brightness: 0, contrast: 0, saturation: 0 };

export function newId(): string {
  return crypto.randomUUID();
}

export function createProject(name = "Projeto sem título"): Project {
  return {
    format: "retalho",
    version: 1,
    id: newId(),
    name,
    fps: 30,
    canvas: { width: 1920, height: 1080 },
    materials: {},
    tracks: [],
  };
}

/** Source pixels left after a crop. The clip then fits the canvas with this shape. */
export function croppedSize(
  width: number,
  height: number,
  crop: Crop | undefined,
): { width: number; height: number } {
  if (!crop) return { width, height };
  return { width: width * (1 - crop.left - crop.right), height: height * (1 - crop.top - crop.bottom) };
}

export function segmentEnd(segment: Segment): Us {
  return segment.target.start + segment.target.duration;
}

export function projectDuration(project: Project): Us {
  let end = 0;
  for (const track of project.tracks) {
    const last = track.segments[track.segments.length - 1];
    if (last) end = Math.max(end, segmentEnd(last));
  }
  return end;
}

/** Output pixels for a canvas scaled so its short side matches. Zero keeps the project size. */
export function outputSize(
  canvas: Project["canvas"],
  shortSide = 0,
): { width: number; height: number } {
  const scale = shortSide ? shortSide / Math.min(canvas.width, canvas.height) : 1;
  // H.264 requires even dimensions.
  return { width: Math.round(canvas.width * scale) & ~1, height: Math.round(canvas.height * scale) & ~1 };
}

export function frameDuration(project: Project): Us {
  return Math.round(SECOND / project.fps);
}

export function trackTypeFor(material: Material): TrackType {
  if (!isMediaMaterial(material)) return "text";
  return material.kind === "audio" ? "audio" : "video";
}

export function findSegment(
  project: Project,
  segmentId: string,
): { track: Track; segment: Segment; index: number } | null {
  for (const track of project.tracks) {
    const index = track.segments.findIndex((segment) => segment.id === segmentId);
    if (index >= 0) return { track, segment: track.segments[index]!, index };
  }
  return null;
}
