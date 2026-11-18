import { keyedProps, sampleProp, sampleTransform, sliceKeyframes, upsertKeyframe, writeBase } from "./keyframes";
import {
  DEFAULT_ADJUST,
  DEFAULT_TRANSFORM,
  findSegment,
  frameDuration,
  newId,
  projectDuration,
  segmentEnd,
  trackTypeFor,
  type KeyedProp,
  type Crop,
  type Easing,
  type Marker,
  type Material,
  type Project,
  type Segment,
  type ShapeKind,
  type ShapeMaterial,
  type TextMaterial,
  type Track,
  type TrackType,
  type Transition,
  type Us,
} from "./model";

export const DEFAULT_STILL_DURATION: Us = 5_000_000;
export const DEFAULT_FREEZE_DURATION: Us = 3_000_000;
/** The smallest share of the source a crop may leave on each axis. */
export const MIN_CROP_REMAINDER = 0.05;
export const MIN_SPEED = 0.1;
export const MAX_SPEED = 10;

const TRACK_LABEL: Record<TrackType, string> = { video: "Vídeo", text: "Texto", audio: "Áudio" };

function clone(project: Project): Project {
  return structuredClone(project);
}

function sortSegments(track: Track): void {
  track.segments.sort((a, b) => a.target.start - b.target.start);
}

/** Finds a segment that may change; a locked track refuses every edit. */
function editable(project: Project, segmentId: string) {
  const found = findSegment(project, segmentId);
  return found && !found.track.locked ? found : null;
}

/** Video and audio have a finite source; images and text can stretch freely. */
function sourceLength(material: Material): Us | null {
  return material.kind === "video" || material.kind === "audio" ? material.duration : null;
}

/** A frozen clip holds one frame, so nothing limits how long it can be. */
function sourceLimit(segment: Segment, material: Material): Us | null {
  return segment.frozen ? null : sourceLength(material);
}

export function addTrack(project: Project, type: TrackType): { project: Project; trackId: string } {
  const next = clone(project);
  const count = next.tracks.filter((track) => track.type === type).length;
  const id = newId();
  next.tracks.push({
    id,
    type,
    name: `${TRACK_LABEL[type]} ${count + 1}`,
    muted: false,
    hidden: false,
    segments: [],
  });
  return { project: next, trackId: id };
}

/** Drops empty tracks so the timeline does not fill with leftover lanes. */
export function pruneEmptyTracks(project: Project): Project {
  const tracks = project.tracks.filter((track) => track.segments.length > 0);
  return tracks.length === project.tracks.length ? project : { ...project, tracks };
}

/** Nearest start to wanted where the duration fits; time after the last segment is always free. */
export function nearestFreeStart(track: Track, wanted: Us, duration: Us, ignoreId?: string): Us {
  const candidates: Us[] = [];
  const consider = (gapStart: Us, gapEnd: Us) => {
    if (gapEnd - gapStart < duration) return;
    candidates.push(Math.min(Math.max(wanted, gapStart), gapEnd - duration));
  };
  let cursor: Us = 0;
  for (const segment of track.segments) {
    if (segment.id === ignoreId) continue;
    consider(cursor, segment.target.start);
    cursor = Math.max(cursor, segmentEnd(segment));
  }
  consider(cursor, Number.MAX_SAFE_INTEGER);
  return candidates.reduce((best, start) =>
    Math.abs(start - wanted) < Math.abs(best - wanted) ? start : best,
  );
}

export function makeSegment(material: Material, start: Us): Segment {
  const duration = sourceLength(material) ?? DEFAULT_STILL_DURATION;
  return {
    id: newId(),
    materialId: material.id,
    target: { start, duration },
    source: { start: 0, duration },
    speed: 1,
    volume: 1,
    fadeIn: 0,
    fadeOut: 0,
    transform: { ...DEFAULT_TRANSFORM },
    adjust: { ...DEFAULT_ADJUST },
    keyframes: {},
    transitionOut: null,
  };
}

/**
 * Adds a segment. With a trackId it goes to the nearest gap there; without one
 * it uses the first compatible track that is free at that exact time and
 * otherwise opens a new track.
 */
function insertSegment(project: Project, segment: Segment, type: TrackType, trackId?: string): Project {
  const { duration } = segment.target;
  let next = clone(project);
  const writable = next.tracks.filter((item) => item.type === type && !item.locked);
  let track = writable.find((item) => item.id === trackId);
  if (track) {
    segment.target.start = nearestFreeStart(track, segment.target.start, duration);
  } else {
    track = writable.find(
      (item) => nearestFreeStart(item, segment.target.start, duration) === segment.target.start,
    );
  }
  if (!track) {
    const added = addTrack(next, type);
    next = added.project;
    track = next.tracks.find((item) => item.id === added.trackId)!;
  }
  track.segments.push(segment);
  sortSegments(track);
  return next;
}

export function placeMaterial(
  project: Project,
  materialId: string,
  wanted: Us,
  trackId?: string,
): { project: Project; segmentId: string } {
  const material = project.materials[materialId];
  if (!material) throw new Error(`Material não encontrado: ${materialId}`);
  const segment = makeSegment(material, Math.max(0, wanted));
  return {
    project: insertSegment(project, segment, trackTypeFor(material), trackId),
    segmentId: segment.id,
  };
}

/** A clip held on the clipboard, with where it came from. */
export interface CopiedSegment {
  segment: Segment;
  trackId: string;
  trackType: TrackType;
}

export function copySegment(project: Project, segmentId: string): CopiedSegment | null {
  const found = findSegment(project, segmentId);
  if (!found) return null;
  return {
    segment: structuredClone(found.segment),
    trackId: found.track.id,
    trackType: found.track.type,
  };
}

/**
 * Pastes at a time, on the original track when it is free there. Text gets its
 * own material, otherwise editing the copy would also rewrite the original.
 */
export function pasteSegment(
  project: Project,
  copy: CopiedSegment,
  at: Us,
): { project: Project; segmentId: string } | null {
  const material = project.materials[copy.segment.materialId];
  if (!material) return null;
  const segment: Segment = {
    ...structuredClone(copy.segment),
    id: newId(),
    target: { start: Math.max(0, at), duration: copy.segment.target.duration },
    transitionOut: null,
  };
  let base = project;
  if (material.kind === "text" || material.kind === "shape") {
    segment.materialId = newId();
    base = {
      ...project,
      materials: { ...project.materials, [segment.materialId]: { ...material, id: segment.materialId } },
    };
  }
  const origin = base.tracks.find((track) => track.id === copy.trackId);
  const isFree =
    origin &&
    !origin.locked &&
    nearestFreeStart(origin, segment.target.start, segment.target.duration) === segment.target.start;
  return {
    project: insertSegment(base, segment, copy.trackType, isFree ? origin.id : undefined),
    segmentId: segment.id,
  };
}

/** Copies a clip to right after itself, or to the next gap that fits on its track. */
export function duplicateSegment(
  project: Project,
  segmentId: string,
): { project: Project; segmentId: string } | null {
  const found = editable(project, segmentId);
  const copy = found && copySegment(project, segmentId);
  if (!found || !copy) return null;
  const start = nearestFreeStart(found.track, segmentEnd(found.segment), found.segment.target.duration);
  return pasteSegment(project, copy, start);
}

/** Copies look and sound from another clip; content, timing and speed stay as they are. */
export function pasteAttributes(project: Project, segmentId: string, from: Segment): Project {
  return updateSegment(project, segmentId, (segment) => {
    const { duration } = segment.target;
    segment.transform = { ...from.transform };
    segment.adjust = { ...from.adjust };
    segment.fit = from.fit;
    segment.flipX = from.flipX;
    segment.flipY = from.flipY;
    segment.blend = from.blend;
    segment.animIn = from.animIn;
    segment.animOut = from.animOut;
    segment.animLoop = from.animLoop;
    segment.letters = from.letters;
    segment.crop = from.crop;
    segment.frame = from.frame;
    segment.mask = from.mask;
    segment.matte = from.matte;
    segment.chroma = from.chroma;
    segment.hsl = from.hsl;
    segment.curves = from.curves;
    segment.lut = from.lut;
    segment.effects = from.effects;
    segment.volume = from.volume;
    segment.pan = from.pan;
    segment.audioEffects = from.audioEffects;
    segment.changePitch = from.changePitch;
    segment.denoise = from.denoise;
    segment.fadeIn = Math.min(from.fadeIn, duration);
    segment.fadeOut = Math.min(from.fadeOut, duration);
    segment.keyframes = {};
    for (const prop of keyedProps(from)) {
      const keyframes = from.keyframes[prop];
      if (keyframes?.length) segment.keyframes[prop] = sliceKeyframes(keyframes, 0, duration);
    }
  });
}

export function addTextMaterial(
  project: Project,
  text = "Seu texto aqui",
): { project: Project; materialId: string } {
  const material: TextMaterial = {
    id: newId(),
    kind: "text",
    text,
    fontFamily: "Arial",
    fontSize: 96,
    color: "#ffffff",
    bold: true,
    italic: false,
    align: "center",
    strokeColor: "#000000",
    strokeWidth: 0,
    background: "",
  };
  return {
    project: { ...project, materials: { ...project.materials, [material.id]: material } },
    materialId: material.id,
  };
}

export function addAdjustmentMaterial(project: Project): { project: Project; materialId: string } {
  const id = newId();
  return {
    project: { ...project, materials: { ...project.materials, [id]: { id, kind: "adjustment" } } },
    materialId: id,
  };
}

export function addShapeMaterial(project: Project, shape: ShapeKind): { project: Project; materialId: string } {
  const line = shape === "line";
  const material: ShapeMaterial = {
    id: newId(),
    kind: "shape",
    shape,
    fill: line ? "" : "#f2a33a",
    fill2: "",
    gradientAngle: 90,
    stroke: line ? "#ffffff" : "#ffffff",
    strokeWidth: line ? 12 : 0,
    radius: 0,
    width: line ? 0.7 : 0.4,
    height: line ? 0.02 : 0.4,
  };
  return {
    project: { ...project, materials: { ...project.materials, [material.id]: material } },
    materialId: material.id,
  };
}

/** Changes a word or phrase in every text, and in the timing of captions made from speech. */
export function replaceInTexts(project: Project, find: string, replacement: string): { project: Project; count: number } {
  if (!find) return { project, count: 0 };
  const materials = { ...project.materials };
  let count = 0;
  for (const material of Object.values(materials)) {
    if (material.kind !== "text" || !material.text.includes(find)) continue;
    count += material.text.split(find).length - 1;
    materials[material.id] = {
      ...material,
      text: material.text.split(find).join(replacement),
      ...(material.timing
        ? { timing: material.timing.map((word) => ({ ...word, text: word.text.split(find).join(replacement) })) }
        : {}),
    };
  }
  return { project: count ? { ...project, materials } : project, count };
}

/** Moves a segment to a track and time, resolving collisions to the nearest gap. */
export function moveSegment(
  project: Project,
  segmentId: string,
  wanted: Us,
  trackId: string,
): Project {
  const next = clone(project);
  const found = editable(next, segmentId);
  const destination = next.tracks.find((track) => track.id === trackId);
  if (!found || !destination || destination.locked || destination.type !== found.track.type) {
    return project;
  }
  const { track, segment } = found;
  segment.target.start = nearestFreeStart(
    destination,
    Math.max(0, wanted),
    segment.target.duration,
    segment.id,
  );
  if (destination !== track) {
    track.segments = track.segments.filter((item) => item.id !== segment.id);
    destination.segments.push(segment);
  }
  sortSegments(destination);
  return next;
}

/** The clips that move with one: itself, plus the rest of its group. */
export function groupMembers(project: Project, segmentId: string): string[] {
  const group = findSegment(project, segmentId)?.segment.group;
  if (!group) return [segmentId];
  return project.tracks.flatMap((track) =>
    track.segments.filter((segment) => segment.group === group).map((segment) => segment.id),
  );
}

export function setGroup(project: Project, segmentIds: string[], group: string | null): Project {
  return segmentIds.reduce(
    (next, id) =>
      updateSegment(next, id, (segment) => {
        if (group) segment.group = group;
        else delete segment.group;
      }),
    project,
  );
}

/** Slides clips by the same amount, keeping their distance from each other. */
export function shiftSegments(project: Project, segmentIds: string[], delta: Us): Project {
  const found = segmentIds.map((id) => findSegment(project, id)).filter((item) => item !== null);
  if (found.length === 0 || found.some(({ track }) => track.locked)) return project;
  const earliest = Math.min(...found.map(({ segment }) => segment.target.start));
  const shift = Math.max(delta, -earliest);
  const moving = new Set(segmentIds);
  const next = clone(project);
  for (const track of next.tracks) {
    const others = track.segments.filter((segment) => !moving.has(segment.id));
    const moved = track.segments.filter((segment) => moving.has(segment.id));
    const collides = moved.some((segment) =>
      others.some(
        (other) =>
          segment.target.start + shift < segmentEnd(other) &&
          segmentEnd(segment) + shift > other.target.start,
      ),
    );
    if (collides) return project;
    for (const segment of moved) segment.target.start += shift;
    sortSegments(track);
  }
  return next;
}

/** Splits at a time strictly inside the segment; the transition stays on the right part. */
export function splitSegment(
  project: Project,
  segmentId: string,
  at: Us,
): { project: Project; rightId: string } | null {
  const next = clone(project);
  const found = editable(next, segmentId);
  if (!found) return null;
  const { track, segment } = found;
  const frame = frameDuration(project);
  const leftDuration = at - segment.target.start;
  if (leftDuration < frame || segmentEnd(segment) - at < frame) return null;

  const fullDuration = segment.target.duration;
  const sourceSplit = Math.round(leftDuration * segment.speed);
  const right: Segment = structuredClone(segment);
  right.id = newId();
  right.target = { start: at, duration: fullDuration - leftDuration };
  if (segment.reversed) {
    // Backwards, the left part plays the end of the source and the right part its start.
    right.source = { start: segment.source.start, duration: segment.source.duration - sourceSplit };
    segment.source = {
      start: segment.source.start + segment.source.duration - sourceSplit,
      duration: sourceSplit,
    };
  } else if (!segment.frozen) {
    right.source = {
      start: segment.source.start + sourceSplit,
      duration: segment.source.duration - sourceSplit,
    };
    segment.source.duration = sourceSplit;
  }
  right.fadeIn = 0;
  delete right.animIn;
  delete right.letters;

  segment.target.duration = leftDuration;
  segment.fadeOut = 0;
  delete segment.animOut;
  segment.transitionOut = null;

  for (const prop of keyedProps(segment)) {
    const keyframes = segment.keyframes[prop];
    if (!keyframes?.length) continue;
    segment.keyframes[prop] = sliceKeyframes(keyframes, 0, leftDuration);
    right.keyframes[prop] = sliceKeyframes(keyframes, leftDuration, fullDuration);
  }

  track.segments.push(right);
  sortSegments(track);
  return { project: next, rightId: right.id };
}

/** Moves the left edge to wanted, bounded by the source, the neighbour and one frame. */
export function trimStart(project: Project, segmentId: string, wanted: Us): Project {
  const next = clone(project);
  const found = editable(next, segmentId);
  if (!found) return project;
  const { track, segment, index } = found;
  const material = next.materials[segment.materialId]!;
  const previous = track.segments[index - 1];
  const end = segmentEnd(segment);

  let start = Math.min(wanted, end - frameDuration(project));
  start = Math.max(start, previous ? segmentEnd(previous) : 0);
  const length = sourceLimit(segment, material);
  if (length !== null) {
    const room = segment.reversed ? length - segment.source.start - segment.source.duration : segment.source.start;
    start = Math.max(start, segment.target.start - Math.floor(room / segment.speed));
  }

  const delta = start - segment.target.start;
  for (const prop of keyedProps(segment)) {
    const keyframes = segment.keyframes[prop];
    if (!keyframes?.length) continue;
    segment.keyframes[prop] =
      delta > 0
        ? sliceKeyframes(keyframes, delta, segment.target.duration)
        : keyframes.map((keyframe) => ({ ...keyframe, offset: keyframe.offset - delta }));
  }
  segment.target = { start, duration: end - start };
  if (!segment.frozen) {
    const sourceDelta = Math.round(delta * segment.speed);
    segment.source = {
      start: segment.reversed ? segment.source.start : Math.max(0, segment.source.start + sourceDelta),
      duration: segment.source.duration - sourceDelta,
    };
  }
  return next;
}

/** Moves the right edge to wanted, bounded by the source, the neighbour and one frame. */
export function trimEnd(project: Project, segmentId: string, wanted: Us): Project {
  const next = clone(project);
  const found = editable(next, segmentId);
  if (!found) return project;
  const { track, segment, index } = found;
  const length = sourceLimit(segment, next.materials[segment.materialId]!);
  const following = track.segments[index + 1];

  let end = Math.max(wanted, segment.target.start + frameDuration(project));
  if (following) end = Math.min(end, following.target.start);
  if (length !== null) {
    const room = segment.reversed ? segment.source.start + segment.source.duration : length - segment.source.start;
    end = Math.min(end, segment.target.start + Math.floor(room / segment.speed));
  }

  segment.target.duration = end - segment.target.start;
  if (!segment.frozen) {
    const duration = Math.round(segment.target.duration * segment.speed);
    if (segment.reversed) segment.source.start += segment.source.duration - duration;
    segment.source.duration = duration;
  }
  return next;
}

export function deleteSegment(project: Project, segmentId: string, ripple = false): Project {
  const next = clone(project);
  const found = editable(next, segmentId);
  if (!found) return project;
  const { track, segment, index } = found;
  track.segments.splice(index, 1);
  if (ripple) {
    for (const later of track.segments.slice(index)) {
      later.target.start -= segment.target.duration;
    }
  }
  return pruneEmptyTracks(next);
}

function timelineTime(segment: Segment, source: Us): Us {
  return segment.target.start + Math.round((source - segment.source.start) / segment.speed);
}

/** Removes a stretch of time from some tracks, closing the gap and moving markers along. */
function cutTime(project: Project, from: Us, to: Us, trackIds: Set<string>): Project {
  let next = project;
  const length = to - from;
  const frame = frameDuration(project);
  for (const trackId of trackIds) {
    for (const at of [to, from]) {
      const track = next.tracks.find((item) => item.id === trackId);
      const crossing = track?.segments.find((segment) => segment.target.start < at && segmentEnd(segment) > at);
      if (crossing) next = splitSegment(next, crossing.id, at)?.project ?? next;
    }
  }
  const result = clone(next);
  for (const track of result.tracks) {
    if (!trackIds.has(track.id)) continue;
    // A sliver under one frame cannot be split off, so it goes with the range.
    track.segments = track.segments.filter(
      (segment) => segment.target.start < from - frame || segmentEnd(segment) > to + frame,
    );
    let previousEnd = 0;
    for (const segment of track.segments) {
      if (segment.target.start >= to - frame) segment.target.start -= length;
      segment.target.start = Math.max(segment.target.start, previousEnd);
      previousEnd = segmentEnd(segment);
    }
  }
  result.markers = (result.markers ?? [])
    .filter((marker) => marker.time < from || marker.time >= to)
    .map((marker) => (marker.time >= to ? { ...marker, time: marker.time - length } : marker));
  return result;
}

/**
 * Cuts stretches of a clip's source out of the timeline. Captions and tracks
 * using the same media go along to stay in sync; other tracks, such as
 * background music, stay whole.
 */
export function cutSourceRanges(
  project: Project,
  segmentId: string,
  ranges: { start: Us; end: Us }[],
): Project {
  const found = editable(project, segmentId);
  // Source time runs the other way in a reversed clip, so these ranges would land elsewhere.
  if (!found || found.segment.reversed) return project;
  const { segment, track } = found;
  const affected = new Set(
    project.tracks
      .filter(
        (item) =>
          !item.locked &&
          (item.id === track.id ||
            item.type === "text" ||
            item.segments.some((other) => other.materialId === segment.materialId)),
      )
      .map((item) => item.id),
  );

  const merged: { start: Us; end: Us }[] = [];
  for (const range of [...ranges].sort((a, b) => a.start - b.start)) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
    else merged.push({ ...range });
  }

  // Working backwards keeps the earlier times valid while the later ones are removed.
  let next = project;
  for (const { start, end } of merged.reverse()) {
    const from = Math.max(timelineTime(segment, start), segment.target.start);
    const to = Math.min(timelineTime(segment, end), segmentEnd(segment));
    if (to > from) next = cutTime(next, from, to, affected);
  }
  return next === project ? project : pruneEmptyTracks(next);
}

/** Splits a clip at moments of its source, such as scene changes. */
export function splitAtSources(project: Project, segmentId: string, sources: Us[]): Project {
  const found = editable(project, segmentId);
  if (!found) return project;
  let next = project;
  // From the end, so the original id always keeps the part still to be split.
  for (const source of [...sources].sort((a, b) => b - a)) {
    next = splitSegment(next, segmentId, timelineTime(found.segment, source))?.project ?? next;
  }
  return next;
}

/** Retimes a segment around a fixed source range and shifts what follows on its track. */
export function setSpeed(project: Project, segmentId: string, speed: number): Project {
  const next = clone(project);
  const found = editable(next, segmentId);
  if (!found) return project;
  const { track, segment, index } = found;
  if (segment.frozen) return project;
  const clamped = Math.min(MAX_SPEED, Math.max(MIN_SPEED, speed));
  const oldDuration = segment.target.duration;
  const newDuration = Math.max(frameDuration(project), Math.round(segment.source.duration / clamped));
  const ratio = newDuration / oldDuration;
  segment.speed = clamped;
  segment.target.duration = newDuration;
  for (const prop of keyedProps(segment)) {
    const keyframes = segment.keyframes[prop];
    if (!keyframes) continue;
    segment.keyframes[prop] = keyframes.map((keyframe) => ({
      ...keyframe,
      offset: Math.round(keyframe.offset * ratio),
    }));
  }
  const following = track.segments[index + 1];
  if (following) {
    const delta = newDuration - oldDuration;
    const gap = following.target.start - (segment.target.start + oldDuration);
    const shift = delta > 0 ? Math.max(0, delta - gap) : delta;
    for (const later of track.segments.slice(index + 1)) later.target.start += shift;
  }
  return next;
}

/** Puts a video's sound on an audio track, in sync, and silences the clip. */
export function extractAudio(
  project: Project,
  segmentId: string,
): { project: Project; segmentId: string } | null {
  const found = editable(project, segmentId);
  if (!found || found.track.type !== "video") return null;
  const { segment } = found;
  const material = project.materials[segment.materialId];
  if (material?.kind !== "video" || !material.hasAudio) return null;
  if (segment.frozen || segment.volume <= 0) return null;
  const audio: Segment = { ...structuredClone(segment), id: newId(), transitionOut: null };
  const silenced = updateSegment(project, segmentId, (item) => {
    item.volume = 0;
  });
  return { project: insertSegment(silenced, audio, "audio"), segmentId: audio.id };
}

/**
 * Holds the video frame at a time, pushing everything after it on the track
 * later. At the first or last frame the hold goes before or after the clip,
 * because there is nothing to split there.
 */
export function freezeFrame(
  project: Project,
  segmentId: string,
  at: Us,
  duration: Us = DEFAULT_FREEZE_DURATION,
): { project: Project; segmentId: string } | null {
  const found = editable(project, segmentId);
  if (!found || found.segment.frozen) return null;
  const { segment } = found;
  const end = segmentEnd(segment);
  if (project.materials[segment.materialId]?.kind !== "video") return null;
  if (at < segment.target.start || at >= end) return null;

  const frame = frameDuration(project);
  const offset = at - segment.target.start;
  const still: Segment = {
    ...structuredClone(segment),
    id: newId(),
    speed: 1,
    fadeIn: 0,
    fadeOut: 0,
    transform: sampleTransform(segment, offset),
    keyframes: {},
    transitionOut: null,
    frozen: true,
    source: {
      start: Math.round(
        segment.source.start + Math.min(offset, segment.target.duration - frame) * segment.speed,
      ),
      duration: frame,
    },
  };

  delete still.animIn;
  delete still.animOut;
  delete still.animLoop;

  const split = splitSegment(project, segmentId, at);
  const start = split ? at : offset < frame ? segment.target.start : end;
  still.target = { start, duration };
  const next = clone(split?.project ?? project);
  const track = findSegment(next, segmentId)!.track;
  for (const later of track.segments) {
    if (later.target.start >= start) later.target.start += duration;
  }
  track.segments.push(still);
  sortSegments(track);
  return { project: next, segmentId: still.id };
}

export function updateSegment(
  project: Project,
  segmentId: string,
  patch: (segment: Segment) => void,
): Project {
  const next = clone(project);
  const found = editable(next, segmentId);
  if (!found) return project;
  patch(found.segment);
  return next;
}

export function updateMaterial(
  project: Project,
  materialId: string,
  patch: Partial<Material>,
): Project {
  const material = project.materials[materialId];
  if (!material) return project;
  return {
    ...project,
    materials: { ...project.materials, [materialId]: { ...material, ...patch } as Material },
  };
}

export function updateTrack(project: Project, trackId: string, patch: Partial<Track>): Project {
  return {
    ...project,
    tracks: project.tracks.map((track) => (track.id === trackId ? { ...track, ...patch } : track)),
  };
}

/** Writes a value, as a keyframe at the offset when the property is animated. */
export function setProp(
  project: Project,
  segmentId: string,
  prop: KeyedProp,
  value: number,
  offset: Us,
): Project {
  return updateSegment(project, segmentId, (segment) => {
    const keyframes = segment.keyframes[prop];
    if (keyframes?.length) segment.keyframes[prop] = upsertKeyframe(keyframes, offset, value);
    else writeBase(segment, prop, value);
  });
}

/** Sets the easing of a clip's keyframes, or only those at one offset; null makes the moves straight again. */
export function setEasing(project: Project, segmentId: string, ease: Easing | null, at?: Us): Project {
  return updateSegment(project, segmentId, (segment) => {
    for (const prop of keyedProps(segment)) {
      const keyframes = segment.keyframes[prop];
      if (!keyframes) continue;
      segment.keyframes[prop] = keyframes.map((keyframe) => {
        if (at !== undefined && keyframe.offset !== at) return keyframe;
        const { offset, value } = keyframe;
        return ease ? { offset, value, ease } : { offset, value };
      });
    }
  });
}

/** Moves one crop edge, stopping before it meets the opposite edge. Zero on all edges removes it. */
export function setCropEdge(project: Project, segmentId: string, edge: keyof Crop, value: number): Project {
  return updateSegment(project, segmentId, (segment) => {
    const crop: Crop = segment.crop ?? { left: 0, top: 0, right: 0, bottom: 0 };
    const opposite = { left: "right", right: "left", top: "bottom", bottom: "top" } as const;
    const limit = 1 - MIN_CROP_REMAINDER - crop[opposite[edge]];
    const next = { ...crop, [edge]: Math.min(Math.max(0, value), limit) };
    if (Object.values(next).some(Boolean)) segment.crop = next;
    else delete segment.crop;
  });
}

/** Turns a clip a quarter, keeping the angle in the -180..180 range the inspector shows. */
export function rotateQuarter(
  project: Project,
  segmentId: string,
  direction: 1 | -1,
  offset: Us,
): Project {
  const found = findSegment(project, segmentId);
  if (!found) return project;
  const turned = sampleProp(found.segment, "rotation", offset) + direction * 90;
  const wrapped = ((((turned + 180) % 360) + 360) % 360) - 180;
  return setProp(project, segmentId, "rotation", wrapped === -180 ? 180 : wrapped, offset);
}

/** Adds a keyframe at offset, or removes the one already there. */
export function toggleKeyframe(
  project: Project,
  segmentId: string,
  prop: KeyedProp,
  offset: Us,
): Project {
  return updateSegment(project, segmentId, (segment) => {
    const keyframes = segment.keyframes[prop] ?? [];
    const value = sampleProp(segment, prop, offset);
    if (!keyframes.some((keyframe) => keyframe.offset === offset)) {
      segment.keyframes[prop] = upsertKeyframe(keyframes, offset, value);
      return;
    }
    const remaining = keyframes.filter((keyframe) => keyframe.offset !== offset);
    if (remaining.length) {
      segment.keyframes[prop] = remaining;
    } else {
      delete segment.keyframes[prop];
      writeBase(segment, prop, value);
    }
  });
}

/** The segment that directly follows on the same track, if the cut is contiguous. */
export function adjacentNext(project: Project, segmentId: string): Segment | null {
  const found = findSegment(project, segmentId);
  if (!found) return null;
  const following = found.track.segments[found.index + 1];
  return following && following.target.start === segmentEnd(found.segment) ? following : null;
}

export function setTransition(
  project: Project,
  segmentId: string,
  transition: Transition | null,
): Project {
  return updateSegment(project, segmentId, (segment) => {
    segment.transitionOut = transition;
  });
}

export const MARKER_COLOR = "#2fb8c6";

/** Removes the marker on this frame, or adds one. Numbers keep rising so labels stay unique. */
export function toggleMarker(project: Project, time: Us): Project {
  const markers = project.markers ?? [];
  const tolerance = frameDuration(project) / 2;
  const kept = markers.filter((marker) => Math.abs(marker.time - time) > tolerance);
  if (kept.length !== markers.length) return { ...project, markers: kept };
  const used = markers.map((marker) => Number(/(\d+)$/.exec(marker.label)?.[1] ?? 0));
  const number = Math.max(0, ...used) + 1;
  const marker: Marker = {
    id: newId(),
    time,
    label: `Marcador ${String(number).padStart(2, "0")}`,
    color: MARKER_COLOR,
  };
  return { ...project, markers: [...markers, marker].sort((a, b) => a.time - b.time) };
}

export function removeMarker(project: Project, markerId: string): Project {
  return { ...project, markers: (project.markers ?? []).filter((marker) => marker.id !== markerId) };
}

/** The closest marker strictly before or after a time, if any. */
export function adjacentMarker(project: Project, time: Us, direction: 1 | -1): Marker | null {
  const markers = project.markers ?? [];
  const found = direction > 0
    ? markers.find((marker) => marker.time > time)
    : markers.findLast((marker) => marker.time < time);
  return found ?? null;
}

/** A clip's beats in timeline time, leaving out those trimmed away. */
export function beatTimes(segment: Segment): Us[] {
  const { start, duration } = segment.source;
  if (segment.reversed) return [];
  return (segment.beats ?? [])
    .filter((beat) => beat >= start && beat < start + duration)
    .map((beat) => Math.round(segment.target.start + (beat - start) / segment.speed));
}

/** Splits every video under the given timeline moments, such as the beats of a song. */
export function splitVideoAt(project: Project, times: Us[]): Project {
  let next = project;
  for (const time of [...times].sort((a, b) => b - a)) {
    for (const track of next.tracks) {
      if (track.type !== "video" || track.locked) continue;
      const crossing = track.segments.find((segment) => segment.target.start < time && segmentEnd(segment) > time);
      if (crossing) next = splitSegment(next, crossing.id, time)?.project ?? next;
    }
  }
  return next;
}

/** Keeps only a stretch of the timeline, which then starts at zero. */
export function extractRange(project: Project, from: Us, to: Us): Project {
  const all = new Set(project.tracks.map((track) => track.id));
  const open: Project = { ...project, tracks: project.tracks.map((track) => ({ ...track, locked: false })) };
  const end = projectDuration(open);
  const trimmed = to < end ? cutTime(open, to, end, all) : open;
  return from > 0 ? cutTime(trimmed, 0, from, all) : trimmed;
}

/** Snap candidates in timeline time: the origin, the playhead, markers and every other segment edge. */
export function snapPoints(project: Project, playhead: Us, ignoreId?: string): Us[] {
  const points = [0, playhead, ...(project.markers ?? []).map((marker) => marker.time)];
  for (const track of project.tracks) {
    for (const segment of track.segments) {
      if (segment.id !== ignoreId) points.push(segment.target.start, segmentEnd(segment), ...beatTimes(segment));
    }
  }
  return points;
}

export function snap(value: Us, points: Us[], tolerance: Us): Us {
  let best = value;
  let bestDistance = tolerance;
  for (const point of points) {
    const distance = Math.abs(point - value);
    if (distance < bestDistance) {
      best = point;
      bestDistance = distance;
    }
  }
  return best;
}
