import { describe, expect, it } from "vitest";
import { createProject, croppedSize, findSegment } from "../src/core/model";
import { copySegment, pasteAttributes, placeMaterial, setCropEdge, splitSegment, updateTrack } from "../src/core/ops";

function clip() {
  const project = createProject();
  project.materials.clip = {
    id: "clip",
    kind: "video",
    name: "clip.mp4",
    duration: 10_000_000,
    width: 1920,
    height: 1080,
    hasAudio: false,
  };
  return placeMaterial(project, "clip", 0);
}

describe("crop", () => {
  it("keeps the source size without a crop", () => {
    expect(croppedSize(1920, 1080, undefined)).toEqual({ width: 1920, height: 1080 });
  });

  it("removes each edge from the visible size", () => {
    const crop = { left: 0.25, right: 0.25, top: 0.1, bottom: 0 };
    expect(croppedSize(1000, 1000, crop)).toEqual({ width: 500, height: 900 });
  });

  it("sets one edge and leaves the others", () => {
    const { project, segmentId } = clip();
    const next = setCropEdge(setCropEdge(project, segmentId, "left", 0.2), segmentId, "top", 0.1);
    expect(findSegment(next, segmentId)!.segment.crop).toEqual({ left: 0.2, top: 0.1, right: 0, bottom: 0 });
  });

  it("always leaves something visible", () => {
    const { project, segmentId } = clip();
    let next = setCropEdge(project, segmentId, "left", 0.7);
    next = setCropEdge(next, segmentId, "right", 0.9);
    const { crop } = findSegment(next, segmentId)!.segment;
    expect(crop!.left + crop!.right).toBeCloseTo(0.95);
  });

  it("stays within the source", () => {
    const { project, segmentId } = clip();
    const next = setCropEdge(project, segmentId, "left", -1);
    expect(findSegment(next, segmentId)!.segment.crop).toBeUndefined();
  });

  it("goes away when every edge returns to zero", () => {
    const { project, segmentId } = clip();
    const next = setCropEdge(setCropEdge(project, segmentId, "left", 0.2), segmentId, "left", 0);
    expect(findSegment(next, segmentId)!.segment.crop).toBeUndefined();
  });

  it("follows split and paste attributes, and respects a lock", () => {
    const { project, segmentId } = clip();
    const cropped = setCropEdge(project, segmentId, "left", 0.2);
    const split = splitSegment(cropped, segmentId, 5_000_000)!;
    expect(findSegment(split.project, split.rightId)!.segment.crop?.left).toBe(0.2);
    const other = placeMaterial(cropped, "clip", 20_000_000);
    const pasted = pasteAttributes(other.project, other.segmentId, copySegment(cropped, segmentId)!.segment);
    expect(findSegment(pasted, other.segmentId)!.segment.crop?.left).toBe(0.2);
    const locked = updateTrack(project, project.tracks[0]!.id, { locked: true });
    expect(setCropEdge(locked, segmentId, "left", 0.5)).toBe(locked);
  });
});
