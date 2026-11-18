import { describe, expect, it } from "vitest";
import { sampleKeyframes, sampleProp } from "../src/core/keyframes";
import { createProject, findSegment, type Easing } from "../src/core/model";
import { MOTION_PRESETS, applyMotion } from "../src/core/motion";
import { placeMaterial, setProp, updateTrack } from "../src/core/ops";

const S = 1_000_000;

function clip() {
  const project = createProject();
  project.materials.clip = {
    id: "clip",
    kind: "image",
    name: "foto.png",
    duration: 0,
    width: 1920,
    height: 1080,
    hasAudio: false,
  };
  return placeMaterial(project, "clip", 0);
}

describe("camera moves", () => {
  it("zooms from where the clip is over its whole length", () => {
    const { project, segmentId } = clip();
    const moved = applyMotion(setProp(project, segmentId, "scale", 2, 0), segmentId, "zoomIn");
    const { segment } = findSegment(moved, segmentId)!;
    expect(sampleProp(segment, "scale", 0)).toBe(2);
    expect(sampleProp(segment, "scale", segment.target.duration)).toBeCloseTo(2.5);
  });

  it("keeps a pan from showing the edge of the frame", () => {
    const { project, segmentId } = clip();
    const { segment } = findSegment(applyMotion(project, segmentId, "panLeft"), segmentId)!;
    const scale = sampleProp(segment, "scale", 0);
    const reach = Math.max(...segment.keyframes.x!.map((item) => Math.abs(item.value)));
    expect(reach).toBeLessThanOrEqual(scale - 1);
    expect(sampleProp(segment, "x", 0)).toBeGreaterThan(sampleProp(segment, "x", segment.target.duration));
  });

  it("gives every preset keyframes that end inside the clip", () => {
    const { project, segmentId } = clip();
    for (const { value } of MOTION_PRESETS) {
      const { segment } = findSegment(applyMotion(project, segmentId, value), segmentId)!;
      const offsets = Object.values(segment.keyframes).flatMap((list) => list!.map((item) => item.offset));
      expect(offsets.length).toBeGreaterThan(1);
      expect(Math.max(...offsets)).toBeLessThanOrEqual(segment.target.duration);
    }
  });

  it("replaces the previous move, and can be removed", () => {
    const { project, segmentId } = clip();
    const first = applyMotion(project, segmentId, "panLeft");
    const second = applyMotion(first, segmentId, "zoomIn");
    expect(findSegment(second, segmentId)!.segment.keyframes.x).toBeUndefined();
    const none = applyMotion(second, segmentId, null);
    expect(findSegment(none, segmentId)!.segment.keyframes).toEqual({});
  });

  it("keeps opacity keyframes the move does not use", () => {
    const { project, segmentId } = clip();
    const faded = {
      ...project,
      tracks: project.tracks.map((track) => ({
        ...track,
        segments: track.segments.map((segment) => ({
          ...segment,
          keyframes: { opacity: [{ offset: 0, value: 0.5 }] },
        })),
      })),
    };
    const moved = applyMotion(faded, segmentId, "zoomIn");
    expect(findSegment(moved, segmentId)!.segment.keyframes.opacity).toHaveLength(1);
  });

  it("respects a locked track", () => {
    const { project, segmentId } = clip();
    const locked = updateTrack(project, project.tracks[0]!.id, { locked: true });
    expect(applyMotion(locked, segmentId, "zoomIn")).toBe(locked);
  });
});

describe("springy curves", () => {
  const curve = (ease: Easing) => [
    { offset: 0, value: 0, ease },
    { offset: 10 * S, value: 100 },
  ];

  it("overshoots before settling", () => {
    const values = Array.from({ length: 99 }, (_, index) => sampleKeyframes(curve("back"), (index + 1) * 0.1 * S));
    expect(Math.max(...values)).toBeGreaterThan(100);
    const springy = Array.from({ length: 99 }, (_, index) => sampleKeyframes(curve("elastic"), (index + 1) * 0.1 * S));
    expect(Math.max(...springy)).toBeGreaterThan(100);
  });

  it("bounces without passing the end", () => {
    const values = Array.from({ length: 99 }, (_, index) => sampleKeyframes(curve("bounce"), (index + 1) * 0.1 * S));
    expect(Math.max(...values)).toBeLessThanOrEqual(100.001);
    const falls = values.filter((value, index) => index > 0 && value < values[index - 1]!);
    expect(falls.length).toBeGreaterThan(5);
  });

  it("starts and ends exactly on the keyframes", () => {
    for (const ease of ["back", "elastic", "bounce"] as const) {
      expect(sampleKeyframes(curve(ease), 0)).toBeCloseTo(0);
      expect(sampleKeyframes(curve(ease), 10 * S)).toBeCloseTo(100);
    }
  });
});
