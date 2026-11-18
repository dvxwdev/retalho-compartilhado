import { describe, expect, it } from "vitest";
import { animate } from "../src/core/animation";
import { createProject, findSegment, type Project, type Segment } from "../src/core/model";
import {
  addTextMaterial,
  copySegment,
  freezeFrame,
  pasteAttributes,
  placeMaterial,
  splitSegment,
  updateSegment,
} from "../src/core/ops";
import { resolveFrame } from "../src/core/resolve";

const S = 1_000_000;
const REST = { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 };

function clip(extra: Partial<Segment>): Segment {
  return { target: { start: 0, duration: 4 * S }, ...extra } as Segment;
}

function withVideo(): Project {
  const project = createProject();
  project.materials.clip = {
    id: "clip",
    kind: "video",
    name: "clip.mp4",
    duration: 10 * S,
    width: 1920,
    height: 1080,
    hasAudio: true,
  };
  return project;
}

describe("entrance", () => {
  const rise = clip({ animIn: { type: "rise", duration: S } });

  it("starts away and invisible, and settles at rest", () => {
    const start = animate(rise, REST, 0).transform;
    expect(start.opacity).toBe(0);
    expect(start.y).toBeLessThan(0);
    expect(animate(rise, REST, S).transform).toEqual(REST);
    expect(animate(rise, REST, 3 * S).transform).toEqual(REST);
  });

  it("moves towards rest over time", () => {
    const early = animate(rise, REST, 0.2 * S).transform.y;
    const late = animate(rise, REST, 0.8 * S).transform.y;
    expect(Math.abs(late)).toBeLessThan(Math.abs(early));
  });

  it("comes from the side it is named after", () => {
    const fromLeft = clip({ animIn: { type: "left", duration: S } });
    const fromRight = clip({ animIn: { type: "right", duration: S } });
    expect(animate(fromLeft, REST, 0).transform.x).toBeLessThan(0);
    expect(animate(fromRight, REST, 0).transform.x).toBeGreaterThan(0);
  });

  it("pops past full size before settling", () => {
    const pop = clip({ animIn: { type: "pop", duration: S } });
    expect(animate(pop, REST, 0.6 * S).transform.scale).toBeGreaterThan(1);
    expect(animate(pop, REST, S).transform.scale).toBeCloseTo(1);
  });

  it("types without moving the clip", () => {
    const typing = clip({ animIn: { type: "type", duration: S } });
    const half = animate(typing, REST, 0.5 * S);
    expect(half.reveal).toBeCloseTo(0.5);
    expect(half.transform).toEqual(REST);
    expect(animate(typing, REST, 2 * S).reveal).toBe(1);
  });
});

describe("exit", () => {
  const rise = clip({ animOut: { type: "rise", duration: S } });

  it("leaves untouched until its time, then goes away", () => {
    expect(animate(rise, REST, 3 * S).transform).toEqual(REST);
    const end = animate(rise, REST, 4 * S).transform;
    expect(end.opacity).toBe(0);
    expect(end.y).toBeGreaterThan(0);
  });
});

describe("loop", () => {
  const pulse = clip({ animLoop: { type: "pulse", duration: S } });

  it("repeats on every cycle", () => {
    const first = animate(pulse, REST, 0.25 * S).transform.scale;
    expect(first).toBeGreaterThan(1);
    expect(animate(pulse, REST, 1.25 * S).transform.scale).toBeCloseTo(first);
    expect(animate(pulse, REST, 0.75 * S).transform.scale).toBeLessThan(1);
  });

  it("gives the same result for the same time", () => {
    const shake = clip({ animLoop: { type: "shake", duration: S } });
    expect(animate(shake, REST, 0.3 * S)).toEqual(animate(shake, REST, 0.3 * S));
  });
});

describe("short clips", () => {
  it("shrinks entrance and exit together so both finish", () => {
    const both = clip({
      target: { start: 0, duration: S },
      animIn: { type: "fade", duration: S },
      animOut: { type: "fade", duration: S },
    });
    expect(animate(both, REST, 0.5 * S).transform.opacity).toBeCloseTo(1);
    expect(animate(both, REST, 0).transform.opacity).toBe(0);
    expect(animate(both, REST, S).transform.opacity).toBe(0);
  });

  it("composes with the clip's own position and opacity", () => {
    const fade = clip({ animIn: { type: "fade", duration: S } });
    const moved = { ...REST, x: 0.3, opacity: 0.5 };
    expect(animate(fade, moved, S).transform).toEqual(moved);
  });
});

describe("in the project", () => {
  function animated() {
    const placed = placeMaterial(withVideo(), "clip", 0);
    const project = updateSegment(placed.project, placed.segmentId, (segment) => {
      segment.animIn = { type: "fade", duration: S };
      segment.animOut = { type: "fade", duration: S };
    });
    return { project, id: placed.segmentId };
  }

  it("reaches the frame that gets drawn", () => {
    const { project } = animated();
    expect(resolveFrame(project, 0)[0]!.transform.opacity).toBe(0);
    expect(resolveFrame(project, 5 * S)[0]!.transform.opacity).toBe(1);
  });

  it("keeps the entrance on the left part and the exit on the right part of a split", () => {
    const { project, id } = animated();
    const split = splitSegment(project, id, 5 * S)!;
    const left = findSegment(split.project, id)!.segment;
    const right = findSegment(split.project, split.rightId)!.segment;
    expect(left.animIn).toBeDefined();
    expect(left.animOut).toBeUndefined();
    expect(right.animIn).toBeUndefined();
    expect(right.animOut).toBeDefined();
  });

  it("leaves a frozen frame still", () => {
    const { project, id } = animated();
    const frozen = freezeFrame(project, id, 5 * S)!;
    const still = findSegment(frozen.project, frozen.segmentId)!.segment;
    expect(still.animIn).toBeUndefined();
    expect(still.animOut).toBeUndefined();
  });

  it("travels with paste attributes", () => {
    const { project, id } = animated();
    const other = placeMaterial(project, "clip", 20 * S);
    const pasted = pasteAttributes(other.project, other.segmentId, copySegment(project, id)!.segment);
    expect(findSegment(pasted, other.segmentId)!.segment.animIn?.type).toBe("fade");
  });

  it("works on text", () => {
    const added = addTextMaterial(createProject(), "Oi");
    const placed = placeMaterial(added.project, added.materialId, 0);
    const project = updateSegment(placed.project, placed.segmentId, (segment) => {
      segment.animIn = { type: "type", duration: 2 * S };
    });
    expect(resolveFrame(project, S)[0]!.reveal).toBeCloseTo(0.5);
  });
});
