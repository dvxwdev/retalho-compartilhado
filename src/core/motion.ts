import type { AnimatableProp, Keyframe, Project, Segment, Us } from "./model";
import { updateSegment } from "./ops";

export type MotionPreset = "zoomIn" | "zoomOut" | "panLeft" | "panRight" | "panUp" | "panDown" | "punch" | "drift";

export const MOTION_PRESETS: { value: MotionPreset; label: string }[] = [
  { value: "zoomIn", label: "Aproximar" },
  { value: "zoomOut", label: "Afastar" },
  { value: "panLeft", label: "Esquerda" },
  { value: "panRight", label: "Direita" },
  { value: "panUp", label: "Subir" },
  { value: "panDown", label: "Descer" },
  { value: "punch", label: "Impacto" },
  { value: "drift", label: "Flutuar" },
];

const ZOOM = 1.25;
/** Panning needs room around the frame, so the clip grows enough to never show its edge. */
const PAN_SCALE = 1.3;
const PAN_DISTANCE = 0.25;
const PUNCH_SCALE = 1.18;
const PUNCH_LENGTH: Us = 350_000;
const MOVED: AnimatableProp[] = ["x", "y", "scale"];

function move(from: number, to: number, end: Us, ease: Keyframe["ease"]): Keyframe[] {
  return [
    { offset: 0, value: from, ...(ease ? { ease } : {}) },
    { offset: end, value: to },
  ];
}

function keyframesFor(preset: MotionPreset, segment: Segment): Segment["keyframes"] {
  const { x, y, scale } = segment.transform;
  const end = segment.target.duration;
  const wide = scale * PAN_SCALE;
  switch (preset) {
    case "zoomIn":
      return { scale: move(scale, scale * ZOOM, end, "inOut") };
    case "zoomOut":
      return { scale: move(scale * ZOOM, scale, end, "inOut") };
    case "panLeft":
      return { scale: move(wide, wide, end, undefined), x: move(x + PAN_DISTANCE, x - PAN_DISTANCE, end, "inOut") };
    case "panRight":
      return { scale: move(wide, wide, end, undefined), x: move(x - PAN_DISTANCE, x + PAN_DISTANCE, end, "inOut") };
    case "panUp":
      return { scale: move(wide, wide, end, undefined), y: move(y - PAN_DISTANCE, y + PAN_DISTANCE, end, "inOut") };
    case "panDown":
      return { scale: move(wide, wide, end, undefined), y: move(y + PAN_DISTANCE, y - PAN_DISTANCE, end, "inOut") };
    case "punch": {
      const hit = Math.min(PUNCH_LENGTH, end);
      return {
        scale: [
          { offset: 0, value: scale * PUNCH_SCALE, ease: "out" },
          { offset: hit, value: scale },
        ],
      };
    }
    case "drift":
      return {
        scale: move(scale * 1.08, scale * 1.08, end, undefined),
        x: move(x - 0.03, x + 0.03, end, "inOut"),
        y: move(y + 0.02, y - 0.02, end, "inOut"),
      };
  }
}

/** Animates a clip's framing over its whole length, replacing earlier moves. */
export function applyMotion(project: Project, segmentId: string, preset: MotionPreset | null): Project {
  return updateSegment(project, segmentId, (segment) => {
    for (const prop of MOVED) delete segment.keyframes[prop];
    if (preset) Object.assign(segment.keyframes, keyframesFor(preset, segment));
  });
}
