import { animate } from "./animation";
import { sampledLook, sampleTransform } from "./keyframes";
import {
  frameDuration,
  segmentEnd,
  type AudioEffects,
  type Material,
  type Project,
  type Segment,
  type TimeRange,
  type Track,
  type Transform,
  type Transition,
  type Us,
} from "./model";

export interface Layer {
  segment: Segment;
  material: Material;
  trackId: string;
  /** Read position in the material. */
  sourceTime: Us;
  /** Time since the clip began, which drives effects that move. */
  time: Us;
  /** Includes animation, so this is where the clip is drawn, not its resting place. */
  transform: Transform;
  /** Fraction of a text shown, while it is being typed. */
  reveal: number;
  /** Multiplies transform.opacity during a transition. */
  opacityMul: number;
  /** Horizontal shift in canvas widths during a transition. */
  offsetX: number;
  /** Fraction of the canvas width shown from the left, for wipes. */
  revealX: number;
  /** Fraction of a circle opened from the centre, for iris transitions. */
  revealCircle: number;
}

/** Half-span around a cut, limited so a transition never covers more than half of either clip. */
export function transitionHalf(left: Segment, right: Segment, transition: Transition): Us {
  return Math.min(transition.duration / 2, left.target.duration / 2, right.target.duration / 2);
}

function drawOrder(tracks: Track[]): Track[] {
  return [
    ...tracks.filter((track) => track.type === "video"),
    ...tracks.filter((track) => track.type === "text"),
  ];
}

function sourceTimeAt(segment: Segment, offset: Us, frame: Us): Us {
  if (segment.frozen) return segment.source.start;
  if (segment.reversed) {
    const fromEnd = (offset + frame) * segment.speed;
    return Math.round(segment.source.start + Math.max(0, segment.source.duration - fromEnd));
  }
  return Math.round(segment.source.start + offset * segment.speed);
}

function makeLayer(project: Project, track: Track, segment: Segment, time: Us): Layer | null {
  const material = project.materials[segment.materialId];
  if (!material) return null;
  // Transitions reach past a clip's edges, where it holds its first or last frame.
  const offset = Math.min(Math.max(time - segment.target.start, 0), segment.target.duration);
  const timed = material.kind === "video" || material.kind === "audio";
  // source.start + duration is the first frame after the clip, so the hold stops one frame short.
  const heldOffset = Math.min(offset, segment.target.duration - frameDuration(project));
  const { transform, reveal } = animate(segment, sampleTransform(segment, offset), offset);
  return {
    segment: sampledLook(segment, offset),
    material,
    trackId: track.id,
    time: offset,
    sourceTime: timed ? sourceTimeAt(segment, heldOffset, frameDuration(project)) : 0,
    transform,
    reveal,
    opacityMul: 1,
    offsetX: 0,
    revealX: 1,
    revealCircle: 1,
  };
}

function applyTransition(
  outgoing: Layer,
  incoming: Layer,
  transition: Transition,
  progress: number,
): void {
  switch (transition.type) {
    case "fade":
      incoming.opacityMul = progress;
      break;
    case "dip":
      outgoing.opacityMul = Math.max(0, 1 - progress * 2);
      incoming.opacityMul = Math.max(0, progress * 2 - 1);
      break;
    case "slide":
      outgoing.offsetX = -progress;
      incoming.offsetX = 1 - progress;
      break;
    case "wipe":
      incoming.revealX = progress;
      break;
    case "push":
      outgoing.transform.y += progress * 2;
      incoming.transform.y -= (1 - progress) * 2;
      break;
    case "zoom":
      outgoing.transform.scale *= 1 + progress;
      outgoing.opacityMul = 1 - progress;
      incoming.transform.scale *= 0.6 + 0.4 * progress;
      incoming.opacityMul = progress;
      break;
    case "spin":
      incoming.transform.rotation -= (1 - progress) * 180;
      incoming.transform.scale *= progress;
      break;
    case "iris":
      incoming.revealCircle = progress;
      break;
  }
}

/** Everything visible at a time, in draw order. Pure, so preview and export agree. */
export function resolveFrame(project: Project, time: Us): Layer[] {
  const layers: Layer[] = [];
  for (const track of drawOrder(project.tracks)) {
    if (track.hidden) continue;
    const { segments } = track;
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index]!;
      const following = segments[index + 1];
      const transition = segment.transitionOut;
      if (transition && following && following.target.start === segmentEnd(segment)) {
        const cut = segmentEnd(segment);
        const half = transitionHalf(segment, following, transition);
        if (time >= cut - half && time < cut + half) {
          const outgoing = makeLayer(project, track, segment, time);
          const incoming = makeLayer(project, track, following, time);
          if (outgoing && incoming) {
            applyTransition(outgoing, incoming, transition, (time - (cut - half)) / (half * 2));
            layers.push(outgoing, incoming);
          }
          break;
        }
      }
      if (time >= segment.target.start && time < segmentEnd(segment)) {
        const layer = makeLayer(project, track, segment, time);
        if (layer) layers.push(layer);
        break;
      }
    }
  }
  return layers;
}

export interface AudioEvent {
  materialId: string;
  /** Timeline time the sound starts, at or after the requested origin. */
  at: Us;
  /** Read position in the material. */
  offset: Us;
  /** Timeline length of the sound. */
  duration: Us;
  rate: number;
  gain: number;
  pan: number;
  effects: AudioEffects | null;
  /** Stretches to dip, in timeline time. */
  dips: { start: Us; end: Us }[];
  /** How much a dip lowers the sound, from 0 to 1. */
  dipAmount: number;
  /** Noise reduction, from 0 to 1. */
  denoise: number;
  /** Plays backwards, which needs the clip processed ahead of time. */
  reversed: boolean;
  /** Keeps the pitch at this rate, which needs the clip processed ahead of time. */
  keepPitch: boolean;
  /** The whole clip, whatever part of it this event plays. */
  source: TimeRange;
  /** Timeline length of the whole clip. */
  length: Us;
  /** Fades in timeline time, measured against the full segment. */
  fadeIn: Us;
  fadeOut: Us;
  /** How far into the segment this event begins. */
  skipped: Us;
}

/** Audio to schedule from a timeline time. Shared by live playback and offline export. */
export function audioPlan(project: Project, from: Us): AudioEvent[] {
  const events: AudioEvent[] = [];
  for (const track of project.tracks) {
    if (track.muted || track.type === "text") continue;
    for (const segment of track.segments) {
      const material = project.materials[segment.materialId];
      if (material?.kind !== "video" && material?.kind !== "audio") continue;
      if (!material.hasAudio || material.offline || segment.volume <= 0 || segment.frozen) continue;
      if (segmentEnd(segment) <= from) continue;
      const skipped = Math.max(0, from - segment.target.start);
      events.push({
        materialId: material.id,
        at: segment.target.start + skipped,
        offset: Math.round(segment.source.start + skipped * segment.speed),
        duration: segment.target.duration - skipped,
        rate: segment.speed,
        gain: segment.volume,
        pan: segment.pan ?? 0,
        effects: segment.audioEffects ?? null,
        dips: (segment.ducking?.ranges ?? []).map(({ start, end }) => ({
          start: segment.target.start + start,
          end: segment.target.start + end,
        })),
        dipAmount: segment.ducking?.amount ?? 0,
        denoise: segment.denoise ?? 0,
        reversed: Boolean(segment.reversed),
        keepPitch: !segment.changePitch,
        source: segment.source,
        length: segment.target.duration,
        fadeIn: segment.fadeIn,
        fadeOut: segment.fadeOut,
        skipped,
      });
    }
  }
  return events;
}
