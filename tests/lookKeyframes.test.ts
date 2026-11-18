import { describe, expect, it } from "vitest";
import { hasAdjustKeys, hasMoveKeys, sampledLook, sampleProp } from "../src/core/keyframes";
import { createProject, findSegment, type Project, type Segment } from "../src/core/model";
import { addShapeMaterial, placeMaterial, setEasing, setProp, setSpeed, splitSegment, toggleKeyframe } from "../src/core/ops";
import { resolveFrame } from "../src/core/resolve";

const S = 1_000_000;

function clip(): { project: Project; id: string } {
  const added = addShapeMaterial(createProject(), "rectangle");
  const placed = placeMaterial(added.project, added.materialId, 0);
  return { project: placed.project, id: placed.segmentId };
}

const segmentOf = (project: Project, id: string): Segment => findSegment(project, id)!.segment;

/** A fade of the brightness from 0 to -100 over two seconds. */
function fading(): { project: Project; id: string } {
  const { project, id } = clip();
  let next = toggleKeyframe(project, id, "brightness", 0);
  next = toggleKeyframe(next, id, "brightness", 2 * S);
  return { project: setProp(next, id, "brightness", -100, 2 * S), id };
}

describe("keyframes of colour and effects", () => {
  it("reaches the compositor as a plain value at each moment", () => {
    const { project } = fading();
    expect(resolveFrame(project, S)[0]!.segment.adjust.brightness).toBeCloseTo(-50);
    expect(resolveFrame(project, 2 * S)[0]!.segment.adjust.brightness).toBe(-100);
  });

  it("leaves the stored clip and an unanimated clip as they are", () => {
    const { project, id } = fading();
    expect(segmentOf(project, id).adjust.brightness).toBe(0);
    const plain = clip();
    const segment = segmentOf(plain.project, plain.id);
    expect(sampledLook(segment, S)).toBe(segment);
  });

  it("animates an effect amount", () => {
    const { project, id } = clip();
    let next = setProp(project, id, "blur", 0, 0);
    next = toggleKeyframe(next, id, "blur", 0);
    next = toggleKeyframe(next, id, "blur", 2 * S);
    next = setProp(next, id, "blur", 1, 2 * S);
    expect(resolveFrame(next, S)[0]!.segment.effects?.blur).toBeCloseTo(0.5);
  });

  it("keeps the last value when the only keyframe goes away", () => {
    const { project, id } = clip();
    let next = setProp(project, id, "contrast", 30, 0);
    next = toggleKeyframe(next, id, "contrast", S);
    next = setProp(next, id, "contrast", 70, S);
    next = toggleKeyframe(next, id, "contrast", S);
    const segment = segmentOf(next, id);
    expect(segment.keyframes.contrast).toBeUndefined();
    expect(segment.adjust.contrast).toBe(70);
  });

  it("survives a split, each half going on from where it was", () => {
    const { project, id } = fading();
    const { project: split, rightId } = splitSegment(project, id, S)!;
    expect(sampleProp(segmentOf(split, id), "brightness", S)).toBeCloseTo(-50);
    expect(sampleProp(segmentOf(split, rightId), "brightness", 0)).toBeCloseTo(-50);
    expect(sampleProp(segmentOf(split, rightId), "brightness", S)).toBeCloseTo(-100);
  });

  it("stretches with a speed change", () => {
    const { project, id } = fading();
    const slower = setSpeed(project, id, 0.5);
    const keys = segmentOf(slower, id).keyframes.brightness!;
    expect(keys[1]!.offset).toBe(4 * S);
  });

  it("tells colour keys apart from moves", () => {
    const { project, id } = fading();
    expect(hasAdjustKeys(segmentOf(project, id))).toBe(true);
    expect(hasMoveKeys(segmentOf(project, id))).toBe(false);
  });
});

describe("easing of one keyframe", () => {
  it("changes that keyframe and keeps the others", () => {
    const { project, id } = fading();
    const single = setEasing(project, id, "bounce", 0);
    const keys = segmentOf(single, id).keyframes.brightness!;
    expect(keys[0]!.ease).toBe("bounce");
    expect(keys[1]!.ease).toBeUndefined();
  });

  it("still sets all of them without an offset", () => {
    const { project, id } = fading();
    const keys = segmentOf(setEasing(project, id, "in"), id).keyframes.brightness!;
    expect(keys.every((keyframe) => keyframe.ease === "in")).toBe(true);
  });
});
