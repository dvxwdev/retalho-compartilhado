import { describe, expect, it } from "vitest";
import { createProject, findSegment, projectDuration, type Project } from "../src/core/model";
import {
  addTextMaterial,
  cutSourceRanges,
  extractAudio,
  placeMaterial,
  setSpeed,
  splitAtSources,
  splitVideoAt,
  toggleMarker,
  updateTrack,
} from "../src/core/ops";
import { PAUSE_MARGIN_SECONDS, detectPauses, detectSilences, soundingRanges } from "../src/core/pauses";
import { resolveFrame } from "../src/core/resolve";
import { frameDifference, pickCuts } from "../src/core/scenes";

const S = 1_000_000;
const RATE = 48000;

function media(extra: Partial<{ audio: boolean }> = {}): Project {
  const project = createProject();
  project.materials.clip = {
    id: "clip",
    kind: "video",
    name: "clip.mp4",
    duration: 10 * S,
    width: 1920,
    height: 1080,
    hasAudio: extra.audio ?? true,
  };
  project.materials.song = {
    id: "song",
    kind: "audio",
    name: "song.wav",
    duration: 30 * S,
    width: 0,
    height: 0,
    hasAudio: true,
  };
  return project;
}

const range = (start: number, end: number) => ({ start: start * S, end: end * S });

describe("cutting ranges out of a clip", () => {
  it("closes the gap and keeps the rest of the sound in order", () => {
    const { project, segmentId } = placeMaterial(media(), "clip", 0);
    const cut = cutSourceRanges(project, segmentId, [range(2, 3), range(6, 7)]);
    expect(projectDuration(cut)).toBe(8 * S);
    expect(cut.tracks[0]!.segments.map((segment) => [segment.source.start, segment.source.duration])).toEqual([
      [0, 2 * S],
      [3 * S, 3 * S],
      [7 * S, 3 * S],
    ]);
    expect(resolveFrame(cut, 2.5 * S)[0]!.sourceTime).toBe(3.5 * S);
  });

  it("handles ranges at the very start and end of the clip", () => {
    const { project, segmentId } = placeMaterial(media(), "clip", 0);
    const cut = cutSourceRanges(project, segmentId, [range(0, 1), range(9, 10)]);
    expect(cut.tracks[0]!.segments).toHaveLength(1);
    expect(cut.tracks[0]!.segments[0]!.target).toEqual({ start: 0, duration: 8 * S });
    expect(cut.tracks[0]!.segments[0]!.source.start).toBe(1 * S);
  });

  it("merges ranges that overlap and ignores those outside the clip", () => {
    const { project, segmentId } = placeMaterial(media(), "clip", 0);
    const cut = cutSourceRanges(project, segmentId, [range(2, 4), range(3, 5), range(20, 21)]);
    expect(projectDuration(cut)).toBe(7 * S);
  });

  it("converts source time at other speeds", () => {
    const placed = placeMaterial(media(), "clip", 0);
    const fast = setSpeed(placed.project, placed.segmentId, 2);
    const cut = cutSourceRanges(fast, placed.segmentId, [range(2, 4)]);
    expect(projectDuration(cut)).toBe(4 * S);
  });

  it("keeps captions and markers in sync", () => {
    const placed = placeMaterial(media(), "clip", 0);
    const text = addTextMaterial(placed.project, "depois");
    const caption = placeMaterial(text.project, text.materialId, 6 * S);
    let project = toggleMarker(caption.project, 8 * S);
    project = toggleMarker(project, 2.5 * S);
    project = cutSourceRanges(project, placed.segmentId, [range(2, 3)]);
    expect(findSegment(project, caption.segmentId)!.segment.target.start).toBe(5 * S);
    expect(project.markers!.map((marker) => marker.time)).toEqual([7 * S]);
  });

  it("cuts a caption that crosses the range", () => {
    const placed = placeMaterial(media(), "clip", 0);
    const text = addTextMaterial(placed.project, "longo");
    const caption = placeMaterial(text.project, text.materialId, 1 * S);
    const cut = cutSourceRanges(caption.project, placed.segmentId, [range(2, 3)]);
    const track = cut.tracks.find((item) => item.type === "text")!;
    expect(track.segments.map((segment) => segment.target)).toEqual([
      { start: 1 * S, duration: 1 * S },
      { start: 2 * S, duration: 3 * S },
    ]);
  });

  it("keeps sound extracted from the same clip in sync", () => {
    const placed = placeMaterial(media(), "clip", 0);
    const { project } = extractAudio(placed.project, placed.segmentId)!;
    const cut = cutSourceRanges(project, placed.segmentId, [range(2, 3)]);
    const audio = cut.tracks.find((track) => track.type === "audio")!;
    expect(audio.segments.map((segment) => segment.source.start)).toEqual([0, 3 * S]);
  });

  it("leaves background music whole", () => {
    const placed = placeMaterial(media(), "clip", 0);
    const music = placeMaterial(placed.project, "song", 0);
    const cut = cutSourceRanges(music.project, placed.segmentId, [range(2, 3)]);
    expect(findSegment(cut, music.segmentId)!.segment.target).toEqual({ start: 0, duration: 30 * S });
  });

  it("respects a locked caption track", () => {
    const placed = placeMaterial(media(), "clip", 0);
    const text = addTextMaterial(placed.project, "fixo");
    const caption = placeMaterial(text.project, text.materialId, 6 * S);
    const trackId = caption.project.tracks.find((track) => track.type === "text")!.id;
    const locked = updateTrack(caption.project, trackId, { locked: true });
    const cut = cutSourceRanges(locked, placed.segmentId, [range(2, 3)]);
    expect(findSegment(cut, caption.segmentId)!.segment.target.start).toBe(6 * S);
  });

  it("refuses a locked clip", () => {
    const placed = placeMaterial(media(), "clip", 0);
    const locked = updateTrack(placed.project, placed.project.tracks[0]!.id, { locked: true });
    expect(cutSourceRanges(locked, placed.segmentId, [range(2, 3)])).toBe(locked);
  });
});

describe("splitting at source times", () => {
  it("makes a clip for each scene", () => {
    const { project, segmentId } = placeMaterial(media(), "clip", 0);
    const split = splitAtSources(project, segmentId, [2 * S, 5 * S]);
    expect(split.tracks[0]!.segments.map((segment) => segment.target.start)).toEqual([0, 2 * S, 5 * S]);
    expect(projectDuration(split)).toBe(10 * S);
  });

  it("converts through trims and speed", () => {
    const placed = placeMaterial(media(), "clip", 4 * S);
    const fast = setSpeed(placed.project, placed.segmentId, 2);
    const split = splitAtSources(fast, placed.segmentId, [4 * S]);
    expect(split.tracks[0]!.segments[1]!.target.start).toBe(6 * S);
  });
});

function speech(parts: [seconds: number, loud: boolean][]): Float32Array {
  const total = parts.reduce((sum, [seconds]) => sum + seconds, 0);
  const samples = new Float32Array(Math.round(total * RATE));
  let position = 0;
  for (const [seconds, loud] of parts) {
    const end = position + Math.round(seconds * RATE);
    for (let index = position; index < end; index += 1) {
      samples[index] = loud ? 0.4 * Math.sin((2 * Math.PI * 200 * index) / RATE) : 0.0005 * Math.sin(index);
    }
    position = end;
  }
  return samples;
}

describe("pause detection", () => {
  it("finds a pause and keeps a margin around the words", () => {
    const [pause] = detectPauses([speech([[1, true], [1, false], [1, true]])], RATE, 0.5);
    expect(pause!.start).toBeCloseTo(1 + PAUSE_MARGIN_SECONDS, 1);
    expect(pause!.end).toBeCloseTo(2 - PAUSE_MARGIN_SECONDS, 1);
  });

  it("measures whole silences, without the margin", () => {
    const [silence] = detectSilences([speech([[1, true], [1, false], [1, true]])], RATE, 0.5);
    expect(silence!.start).toBeCloseTo(1, 1);
    expect(silence!.end).toBeCloseTo(2, 1);
  });

  it("keeps a silence of exactly the minimum, so analysis and cutting agree", () => {
    expect(detectSilences([speech([[1, true], [0.6, false], [1, true]])], RATE, 0.5)).toHaveLength(1);
  });

  it("ignores pauses shorter than the minimum", () => {
    expect(detectPauses([speech([[1, true], [0.3, false], [1, true]])], RATE, 0.5)).toEqual([]);
  });

  it("removes all of the silence at the edges", () => {
    const pauses = detectPauses([speech([[1, false], [1, true], [1, false]])], RATE, 0.5);
    expect(pauses[0]!.start).toBe(0);
    expect(pauses[1]!.end).toBeCloseTo(3, 1);
  });

  it("adapts to a quiet recording", () => {
    const quiet = speech([[1, true], [1, false], [1, true]]).map((sample) => sample * 0.1);
    expect(detectPauses([quiet], RATE, 0.5)).toHaveLength(1);
  });

  it("finds nothing in silence or in steady sound", () => {
    expect(detectPauses([new Float32Array(RATE * 2)], RATE, 0.5)).toEqual([]);
    expect(detectPauses([speech([[3, true]])], RATE, 0.5)).toEqual([]);
    expect(detectPauses([new Float32Array(0)], RATE, 0.5)).toEqual([]);
  });
});

describe("scene cuts", () => {
  const frame = (value: number) => new Uint8ClampedArray([value, value, value, 255, value, value, value, 255]);

  it("measures how different two frames are", () => {
    expect(frameDifference(frame(0), frame(0))).toBe(0);
    expect(frameDifference(frame(0), frame(255))).toBe(1);
    expect(frameDifference(frame(100), frame(151))).toBeCloseTo(0.2);
  });

  it("finds sharp jumps in a still clip", () => {
    expect(pickCuts([0.01, 0.01, 0.6, 0.01, 0.01, 0.01, 0.5, 0.01])).toEqual([2, 6]);
  });

  it("needs a bigger jump in a busy clip", () => {
    const busy = [0.1, 0.12, 0.11, 0.13, 0.14, 0.1, 0.12, 0.13, 0.11, 0.15];
    expect(pickCuts(busy)).toEqual([]);
    expect(pickCuts([...busy, 0.8, ...busy])).toEqual([10]);
  });

  it("ignores a slow fade", () => {
    expect(pickCuts(new Array(20).fill(0.05))).toEqual([]);
  });

  it("copes with no frames", () => {
    expect(pickCuts([])).toEqual([]);
  });
});

describe("speech under music", () => {
  it("finds the stretches between pauses", () => {
    const pauses = [
      { start: 0, end: 1 },
      { start: 3, end: 4 },
    ];
    expect(soundingRanges(pauses, 6)).toEqual([
      { start: 1, end: 3 },
      { start: 4, end: 6 },
    ]);
  });

  it("covers everything when there are no pauses", () => {
    expect(soundingRanges([], 5)).toEqual([{ start: 0, end: 5 }]);
  });

  it("finds nothing in a clip of pure silence", () => {
    expect(soundingRanges([{ start: 0, end: 5 }], 5)).toEqual([]);
  });
});

describe("cutting to the beat", () => {
  it("splits the video at each moment", () => {
    const { project } = placeMaterial(media(), "clip", 0);
    const split = splitVideoAt(project, [2 * S, 4 * S]);
    expect(split.tracks[0]!.segments.map((segment) => segment.target.start)).toEqual([0, 2 * S, 4 * S]);
  });

  it("leaves the audio tracks whole", () => {
    const first = placeMaterial(media(), "clip", 0);
    const music = placeMaterial(first.project, "song", 0);
    const split = splitVideoAt(music.project, [2 * S]);
    expect(findSegment(split, music.segmentId)!.segment.target.duration).toBe(30 * S);
  });

  it("skips moments outside any clip and locked tracks", () => {
    const { project } = placeMaterial(media(), "clip", 0);
    expect(splitVideoAt(project, [50 * S]).tracks[0]!.segments).toHaveLength(1);
    const locked = updateTrack(project, project.tracks[0]!.id, { locked: true });
    expect(splitVideoAt(locked, [2 * S]).tracks[0]!.segments).toHaveLength(1);
  });
});
