import { describe, expect, it } from "vitest";
import { sampleKeyframes, sampleProp, sliceKeyframes } from "../src/core/keyframes";
import { createProject, findSegment, projectDuration, type Project } from "../src/core/model";
import {
  addTextMaterial,
  deleteSegment,
  moveSegment,
  nearestFreeStart,
  placeMaterial,
  setSpeed,
  setTransition,
  snap,
  splitSegment,
  toggleKeyframe,
  trimEnd,
  trimStart,
} from "../src/core/ops";
import { audioPlan, resolveFrame } from "../src/core/resolve";

const S = 1_000_000;

function withVideo(seconds = 10): Project {
  const project = createProject();
  project.materials.clip = {
    id: "clip",
    kind: "video",
    name: "clip.mp4",
    duration: seconds * S,
    width: 1920,
    height: 1080,
    hasAudio: true,
  };
  return project;
}

function place(project: Project, at = 0) {
  return placeMaterial(project, "clip", at);
}

describe("placement", () => {
  it("reuses a free track and opens a new one on collision", () => {
    const first = place(withVideo());
    const second = place(first.project, 2 * S);
    expect(second.project.tracks).toHaveLength(2);
    const third = place(second.project, 10 * S);
    expect(third.project.tracks).toHaveLength(2);
    expect(third.project.tracks[0]!.segments).toHaveLength(2);
  });

  it("finds the nearest gap that fits", () => {
    let { project } = place(withVideo(2));
    project = placeMaterial(project, "clip", 3 * S, project.tracks[0]!.id).project;
    const [track] = project.tracks;
    expect(nearestFreeStart(track!, 1 * S, 1 * S)).toBe(2 * S);
    expect(nearestFreeStart(track!, 1 * S, 2 * S)).toBe(5 * S);
  });
});

describe("split", () => {
  it("keeps total timing and source continuity", () => {
    const { project, segmentId } = place(withVideo());
    const result = splitSegment(project, segmentId, 4 * S)!;
    const [left, right] = result.project.tracks[0]!.segments;
    expect(left!.target).toEqual({ start: 0, duration: 4 * S });
    expect(right!.target).toEqual({ start: 4 * S, duration: 6 * S });
    expect(right!.source.start).toBe(4 * S);
    expect(projectDuration(result.project)).toBe(10 * S);
  });

  it("respects speed when mapping the source", () => {
    const { project, segmentId } = place(withVideo());
    const fast = setSpeed(project, segmentId, 2);
    const result = splitSegment(fast, segmentId, 2 * S)!;
    expect(result.project.tracks[0]!.segments[1]!.source.start).toBe(4 * S);
  });

  it("refuses a cut on the edge", () => {
    const { project, segmentId } = place(withVideo());
    expect(splitSegment(project, segmentId, 0)).toBeNull();
    expect(splitSegment(project, segmentId, 10 * S)).toBeNull();
  });

  it("preserves the animation curve on both halves", () => {
    const { project, segmentId } = place(withVideo());
    let next = toggleKeyframe(project, segmentId, "opacity", 0);
    next = toggleKeyframe(next, segmentId, "opacity", 10 * S);
    const found = findSegment(next, segmentId)!;
    found.segment.keyframes.opacity![1]!.value = 0;
    const [left, right] = splitSegment(next, segmentId, 4 * S)!.project.tracks[0]!.segments;
    expect(sampleProp(left!, "opacity", 4 * S)).toBeCloseTo(0.6);
    expect(sampleProp(right!, "opacity", 0)).toBeCloseTo(0.6);
    expect(sampleProp(right!, "opacity", 3 * S)).toBeCloseTo(0.3);
  });

  it("moves the transition to the right half", () => {
    const { project, segmentId } = place(withVideo());
    const next = setTransition(project, segmentId, { type: "fade", duration: S });
    const [left, right] = splitSegment(next, segmentId, 4 * S)!.project.tracks[0]!.segments;
    expect(left!.transitionOut).toBeNull();
    expect(right!.transitionOut).toEqual({ type: "fade", duration: S });
  });
});

describe("trim", () => {
  it("cannot extend beyond the source", () => {
    const { project, segmentId } = place(withVideo());
    const trimmed = trimEnd(project, segmentId, 50 * S);
    expect(trimmed.tracks[0]!.segments[0]!.target.duration).toBe(10 * S);
    const left = trimStart(project, segmentId, 3 * S);
    const restored = trimStart(left, segmentId, 0);
    expect(restored.tracks[0]!.segments[0]!.source.start).toBe(0);
    expect(restored.tracks[0]!.segments[0]!.target.duration).toBe(10 * S);
  });

  it("stops at the neighbour", () => {
    let { project, segmentId } = place(withVideo(4));
    project = placeMaterial(project, "clip", 6 * S, project.tracks[0]!.id).project;
    project = trimStart(project, segmentId, 2 * S);
    const trimmed = trimEnd(project, segmentId, 9 * S);
    expect(trimmed.tracks[0]!.segments[0]!.target.duration).toBe(2 * S);
    expect(trimmed.tracks[0]!.segments[0]!.source.duration).toBe(2 * S);
  });

  it("advances the source when trimming the start", () => {
    const { project, segmentId } = place(withVideo());
    const segment = trimStart(project, segmentId, 3 * S).tracks[0]!.segments[0]!;
    expect(segment.target).toEqual({ start: 3 * S, duration: 7 * S });
    expect(segment.source).toEqual({ start: 3 * S, duration: 7 * S });
  });
});

describe("move and delete", () => {
  it("never lets clips overlap", () => {
    let { project } = place(withVideo(4));
    const second = placeMaterial(project, "clip", 4 * S, project.tracks[0]!.id);
    project = moveSegment(second.project, second.segmentId, 1 * S, project.tracks[0]!.id);
    const [a, b] = project.tracks[0]!.segments;
    expect(b!.target.start).toBeGreaterThanOrEqual(a!.target.start + a!.target.duration);
  });

  it("rejects a move to an incompatible track", () => {
    const placed = place(withVideo());
    const text = addTextMaterial(placed.project);
    const withText = placeMaterial(text.project, text.materialId, 0);
    const textTrack = withText.project.tracks.find((track) => track.type === "text")!;
    expect(moveSegment(withText.project, placed.segmentId, 0, textTrack.id)).toBe(withText.project);
  });

  it("closes the gap on ripple delete and removes empty tracks", () => {
    let { project, segmentId } = place(withVideo(4));
    const second = placeMaterial(project, "clip", 4 * S, project.tracks[0]!.id);
    project = deleteSegment(second.project, segmentId, true);
    expect(project.tracks[0]!.segments[0]!.target.start).toBe(0);
    expect(deleteSegment(project, second.segmentId).tracks).toHaveLength(0);
  });
});

describe("speed", () => {
  it("changes length, not the source range, and pushes followers", () => {
    let { project, segmentId } = place(withVideo(4));
    project = placeMaterial(project, "clip", 4 * S, project.tracks[0]!.id).project;
    const slow = setSpeed(project, segmentId, 0.5);
    const [a, b] = slow.tracks[0]!.segments;
    expect(a!.target.duration).toBe(8 * S);
    expect(a!.source.duration).toBe(4 * S);
    expect(b!.target.start).toBe(8 * S);
  });
});

describe("keyframes", () => {
  const curve = [
    { offset: 10, value: 0 },
    { offset: 20, value: 10 },
  ];

  it("interpolates and holds", () => {
    expect(sampleKeyframes(curve, 0)).toBe(0);
    expect(sampleKeyframes(curve, 15)).toBe(5);
    expect(sampleKeyframes(curve, 99)).toBe(10);
  });

  it("slices with boundary values", () => {
    expect(sliceKeyframes(curve, 15, 20)).toEqual([
      { offset: 0, value: 5 },
      { offset: 5, value: 10 },
    ]);
  });

  it("toggling twice restores a static value", () => {
    const { project, segmentId } = place(withVideo());
    const on = toggleKeyframe(project, segmentId, "scale", 0);
    const off = toggleKeyframe(on, segmentId, "scale", 0);
    expect(findSegment(off, segmentId)!.segment.keyframes.scale).toBeUndefined();
  });
});

describe("frame resolution", () => {
  function twoClips(type: "fade" | "dip" | "slide" | "wipe") {
    const first = place(withVideo(4));
    const second = placeMaterial(first.project, "clip", 4 * S, first.project.tracks[0]!.id);
    return setTransition(second.project, first.segmentId, { type, duration: 2 * S });
  }

  it("maps source time through speed and trim", () => {
    const { project, segmentId } = place(withVideo());
    const next = setSpeed(trimStart(project, segmentId, 2 * S), segmentId, 2);
    expect(resolveFrame(next, 3 * S)[0]!.sourceTime).toBe(4 * S);
  });

  it("draws video before text regardless of track order", () => {
    const text = addTextMaterial(withVideo());
    const onlyText = placeMaterial(text.project, text.materialId, 0);
    const both = placeMaterial(onlyText.project, "clip", 0);
    expect(resolveFrame(both.project, S).map((layer) => layer.material.kind)).toEqual(["video", "text"]);
  });

  it("hides a track", () => {
    const { project } = place(withVideo());
    project.tracks[0]!.hidden = true;
    expect(resolveFrame(project, S)).toEqual([]);
  });

  it("crossfades around the cut and is exact outside it", () => {
    const project = twoClips("fade");
    expect(resolveFrame(project, 2 * S)).toHaveLength(1);
    const during = resolveFrame(project, 4 * S);
    expect(during).toHaveLength(2);
    expect(during[1]!.opacityMul).toBeCloseTo(0.5);
    expect(resolveFrame(project, 5 * S)).toHaveLength(1);
  });

  it("holds the last frame when a clip runs past its end in a transition", () => {
    const layers = resolveFrame(twoClips("fade"), 4.5 * S);
    expect(layers[0]!.sourceTime).toBe(4 * S - 33_333);
  });

  it("slides and wipes", () => {
    const slide = resolveFrame(twoClips("slide"), 4 * S);
    expect(slide[0]!.offsetX).toBeCloseTo(-0.5);
    expect(slide[1]!.offsetX).toBeCloseTo(0.5);
    expect(resolveFrame(twoClips("wipe"), 4 * S)[1]!.revealX).toBeCloseTo(0.5);
  });

  it("is black at the midpoint of a dip", () => {
    const layers = resolveFrame(twoClips("dip"), 4 * S);
    expect(layers.map((layer) => layer.opacityMul)).toEqual([0, 0]);
  });
});

describe("audio plan", () => {
  it("starts mid-clip at the right source position", () => {
    const { project, segmentId } = place(withVideo());
    const [event] = audioPlan(setSpeed(project, segmentId, 2), 1 * S);
    expect(event).toMatchObject({ at: 1 * S, offset: 2 * S, duration: 4 * S, rate: 2 });
  });

  it("skips muted tracks, silent clips and finished clips", () => {
    const { project } = place(withVideo());
    expect(audioPlan(project, 11 * S)).toEqual([]);
    project.tracks[0]!.muted = true;
    expect(audioPlan(project, 0)).toEqual([]);
  });
});

describe("snap", () => {
  it("takes the closest point within tolerance", () => {
    expect(snap(103, [0, 100, 105], 10)).toBe(105);
    expect(snap(150, [0, 100], 10)).toBe(150);
  });
});
