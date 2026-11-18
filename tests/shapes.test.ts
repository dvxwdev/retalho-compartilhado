import { describe, expect, it } from "vitest";
import { animate } from "../src/core/animation";
import { createProject, findSegment, isMediaMaterial, trackTypeFor, type Segment, type ShapeMaterial } from "../src/core/model";
import { addShapeMaterial, copySegment, pasteSegment, placeMaterial, updateMaterial } from "../src/core/ops";
import { audioPlan, resolveFrame } from "../src/core/resolve";

function shape(kind: ShapeMaterial["shape"] = "rectangle") {
  const added = addShapeMaterial(createProject(), kind);
  return { ...placeMaterial(added.project, added.materialId, 0), materialId: added.materialId };
}

describe("shapes", () => {
  it("sits with the text, above the videos", () => {
    const { project, materialId } = shape();
    expect(trackTypeFor(project.materials[materialId]!)).toBe("text");
    expect(project.tracks[0]!.type).toBe("text");
    expect(isMediaMaterial(project.materials[materialId]!)).toBe(false);
  });

  it("is drawn and makes no sound", () => {
    const { project } = shape();
    expect(resolveFrame(project, 1_000_000)).toHaveLength(1);
    expect(audioPlan(project, 0)).toEqual([]);
  });

  it("can be stretched as long as wanted, like an image", () => {
    const { project, segmentId } = shape();
    expect(findSegment(project, segmentId)!.segment.target.duration).toBe(5_000_000);
  });

  it("gives a pasted shape its own look", () => {
    const { project, segmentId, materialId } = shape();
    const pasted = pasteSegment(project, copySegment(project, segmentId)!, 10_000_000)!;
    const copyId = findSegment(pasted.project, pasted.segmentId)!.segment.materialId;
    expect(copyId).not.toBe(materialId);
    const edited = updateMaterial(pasted.project, copyId, { fill: "#000000" } as never);
    expect((edited.materials[materialId] as ShapeMaterial).fill).toBe("#f2a33a");
  });

  it("starts a line as an outline, with nothing to fill", () => {
    const { project, materialId } = shape("line");
    const line = project.materials[materialId] as ShapeMaterial;
    expect(line.fill).toBe("");
    expect(line.strokeWidth).toBeGreaterThan(0);
  });

  it("draws itself in over the entrance", () => {
    const segment = {
      target: { start: 0, duration: 4_000_000 },
      animIn: { type: "draw", duration: 2_000_000 },
    } as Segment;
    const rest = { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 };
    expect(animate(segment, rest, 1_000_000).reveal).toBeCloseTo(0.5);
    expect(animate(segment, rest, 3_000_000).reveal).toBe(1);
    expect(animate(segment, rest, 1_000_000).transform).toEqual(rest);
  });
});
