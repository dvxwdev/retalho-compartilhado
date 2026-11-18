import { describe, expect, it } from "vitest";
import { sampleKeyframes, sliceKeyframes, upsertKeyframe } from "../src/core/keyframes";
import { createProject, findSegment, type Easing, type Keyframe } from "../src/core/model";
import { placeMaterial, setEasing, setProp, setSpeed, splitSegment, toggleKeyframe } from "../src/core/ops";

const S = 1_000_000;

const curve = (ease?: Easing): Keyframe[] => [
  ease ? { offset: 0, value: 0, ease } : { offset: 0, value: 0 },
  { offset: 10 * S, value: 100 },
];

describe("easing", () => {
  it("stays a straight line without one", () => {
    expect(sampleKeyframes(curve(), 2.5 * S)).toBeCloseTo(25);
  });

  it("starts slow when accelerating and fast when decelerating", () => {
    expect(sampleKeyframes(curve("in"), 2.5 * S)).toBeLessThan(25);
    expect(sampleKeyframes(curve("out"), 2.5 * S)).toBeGreaterThan(25);
  });

  it("is symmetric when smooth", () => {
    const first = sampleKeyframes(curve("inOut"), 2 * S);
    expect(first).toBeLessThan(20);
    expect(sampleKeyframes(curve("inOut"), 8 * S)).toBeCloseTo(100 - first);
    expect(sampleKeyframes(curve("inOut"), 5 * S)).toBeCloseTo(50);
  });

  it("jumps only at the next keyframe when held", () => {
    expect(sampleKeyframes(curve("hold"), 9.9 * S)).toBe(0);
    expect(sampleKeyframes(curve("hold"), 10 * S)).toBe(100);
  });

  it("always ends exactly on the keyframes", () => {
    for (const ease of ["in", "out", "inOut", "hold"] as const) {
      expect(sampleKeyframes(curve(ease), 0)).toBe(0);
      expect(sampleKeyframes(curve(ease), 10 * S)).toBe(100);
    }
  });

  it("survives editing a keyframe's value", () => {
    const changed = upsertKeyframe(curve("in"), 0, 40);
    expect(changed[0]).toEqual({ offset: 0, value: 40, ease: "in" });
  });
});

describe("cutting a curve", () => {
  const samples = [0.5, 1.5, 2.9, 3.1, 4.4];

  it("keeps a whole span eased, without extra points", () => {
    const keyframes: Keyframe[] = [...curve("out"), { offset: 12 * S, value: 100 }];
    const kept = sliceKeyframes(keyframes, 0, 10 * S);
    expect(kept.map((item) => item.offset)).toEqual([0, 10 * S]);
    expect(kept[0]!.ease).toBe("out");
  });

  for (const ease of ["in", "out", "inOut"] as const) {
    it(`follows the original ${ease} curve closely on both sides of a cut`, () => {
      const keyframes = curve(ease);
      const left = sliceKeyframes(keyframes, 0, 5 * S);
      const right = sliceKeyframes(keyframes, 5 * S, 10 * S);
      for (const seconds of samples) {
        const original = sampleKeyframes(keyframes, seconds * S);
        expect(Math.abs(sampleKeyframes(left, seconds * S) - original)).toBeLessThan(2);
        const later = sampleKeyframes(keyframes, (seconds + 5) * S);
        expect(Math.abs(sampleKeyframes(right, seconds * S) - later)).toBeLessThan(2);
      }
      expect(sampleKeyframes(left, 5 * S)).toBeCloseTo(sampleKeyframes(keyframes, 5 * S));
      expect(sampleKeyframes(right, 0)).toBeCloseTo(sampleKeyframes(keyframes, 5 * S));
    });
  }

  it("keeps a hold exact on both sides", () => {
    const keyframes = curve("hold");
    expect(sampleKeyframes(sliceKeyframes(keyframes, 0, 5 * S), 4 * S)).toBe(0);
    const right = sliceKeyframes(keyframes, 5 * S, 10 * S);
    expect(sampleKeyframes(right, 4 * S)).toBe(0);
    expect(sampleKeyframes(right, 5 * S)).toBe(100);
  });

  it("leaves a straight line with only the boundary points", () => {
    expect(sliceKeyframes(curve(), 0, 5 * S)).toEqual([
      { offset: 0, value: 0 },
      { offset: 5 * S, value: 50 },
    ]);
  });
});

describe("on a clip", () => {
  function animated() {
    const project = createProject();
    project.materials.clip = {
      id: "clip",
      kind: "video",
      name: "clip.mp4",
      duration: 10 * S,
      width: 1920,
      height: 1080,
      hasAudio: false,
    };
    const placed = placeMaterial(project, "clip", 0);
    let next = toggleKeyframe(placed.project, placed.segmentId, "x", 0);
    next = toggleKeyframe(next, placed.segmentId, "x", 10 * S);
    next = setProp(next, placed.segmentId, "x", 1, 10 * S);
    return { project: next, id: placed.segmentId };
  }

  it("applies to every keyframe and can be removed", () => {
    const { project, id } = animated();
    const smooth = setEasing(project, id, "inOut");
    expect(findSegment(smooth, id)!.segment.keyframes.x!.every((item) => item.ease === "inOut")).toBe(true);
    const straight = setEasing(smooth, id, null);
    expect(findSegment(straight, id)!.segment.keyframes.x!.some((item) => "ease" in item)).toBe(false);
  });

  it("survives a speed change and a split", () => {
    const { project, id } = animated();
    const smooth = setEasing(project, id, "inOut");
    expect(findSegment(setSpeed(smooth, id, 2), id)!.segment.keyframes.x![0]!.ease).toBe("inOut");
    const split = splitSegment(smooth, id, 5 * S)!;
    const left = findSegment(split.project, id)!.segment.keyframes.x!;
    expect(left.length).toBeGreaterThan(2);
  });
});
