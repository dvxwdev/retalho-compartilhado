import { describe, expect, it } from "vitest";
import { createProject, findSegment, type Project } from "../src/core/model";
import { copySegment, pasteAttributes, placeMaterial, updateSegment } from "../src/core/ops";
import { audioPlan } from "../src/core/resolve";

const S = 1_000_000;

export function withAudio(): Project {
  const project = createProject();
  project.materials.song = {
    id: "song",
    kind: "audio",
    name: "song.wav",
    duration: 10 * S,
    width: 0,
    height: 0,
    hasAudio: true,
  };
  return project;
}

describe("pan", () => {
  it("is centred unless set, and reaches the audio plan", () => {
    const placed = placeMaterial(withAudio(), "song", 0);
    expect(audioPlan(placed.project, 0)[0]!.pan).toBe(0);
    const panned = updateSegment(placed.project, placed.segmentId, (segment) => {
      segment.pan = -0.5;
    });
    expect(audioPlan(panned, 0)[0]!.pan).toBe(-0.5);
  });

  it("travels with paste attributes", () => {
    const first = placeMaterial(withAudio(), "song", 0);
    const second = placeMaterial(first.project, "song", 20 * S);
    const panned = updateSegment(second.project, first.segmentId, (segment) => {
      segment.pan = 1;
    });
    const pasted = pasteAttributes(panned, second.segmentId, copySegment(panned, first.segmentId)!.segment);
    expect(findSegment(pasted, second.segmentId)!.segment.pan).toBe(1);
  });
});
