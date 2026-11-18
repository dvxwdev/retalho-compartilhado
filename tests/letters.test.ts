import { describe, expect, it } from "vitest";
import { LETTER_ANIMATIONS, letterState, type LetterAnimation } from "../src/core/letters";
import { createProject, findSegment } from "../src/core/model";
import {
  addTextMaterial,
  copySegment,
  pasteAttributes,
  placeMaterial,
  splitSegment,
  updateSegment,
} from "../src/core/ops";

const S = 1_000_000;

const animation = (extra: Partial<LetterAnimation> = {}): LetterAnimation => ({
  type: "rise",
  order: "forward",
  duration: 0.5 * S,
  stagger: 0.1 * S,
  ...extra,
});

describe("letter animation", () => {
  it("starts each letter after the one before", () => {
    const rise = animation();
    expect(letterState(rise, 0, 5, 0.2 * S).opacity).toBeGreaterThan(0);
    expect(letterState(rise, 3, 5, 0.2 * S).opacity).toBe(0);
    expect(letterState(rise, 3, 5, 0.4 * S).opacity).toBeGreaterThan(0);
  });

  it("rests when finished, in every type but the wave", () => {
    for (const type of LETTER_ANIMATIONS) {
      if (type === "wave") continue;
      expect(letterState(animation({ type }), 4, 5, 3 * S)).toEqual({ opacity: 1, x: 0, y: 0, scale: 1, rotation: 0 });
    }
  });

  it("keeps a wave going and every letter visible", () => {
    const wave = animation({ type: "wave" });
    const heights = [0.1, 0.3, 0.6].map((seconds) => letterState(wave, 2, 5, seconds * S).y);
    expect(new Set(heights).size).toBe(3);
    expect(letterState(wave, 2, 5, 5 * S).opacity).toBe(1);
  });

  it("can begin at the end", () => {
    const reverse = animation({ order: "reverse" });
    expect(letterState(reverse, 4, 5, 0.1 * S).opacity).toBeGreaterThan(0);
    expect(letterState(reverse, 0, 5, 0.1 * S).opacity).toBe(0);
  });

  it("can open from the middle", () => {
    const center = animation({ order: "center" });
    expect(letterState(center, 2, 5, 0.05 * S).opacity).toBeGreaterThan(0);
    expect(letterState(center, 0, 5, 0.05 * S).opacity).toBe(0);
  });

  it("shuffles the same way on every frame", () => {
    const shuffled = animation({ order: "random" });
    expect(letterState(shuffled, 3, 9, 0.3 * S)).toEqual(letterState(shuffled, 3, 9, 0.3 * S));
    const starts = Array.from({ length: 9 }, (_, index) => letterState(shuffled, index, 9, 0.05 * S).opacity > 0);
    expect(starts.some(Boolean)).toBe(true);
    expect(starts.every(Boolean)).toBe(false);
  });

  it("overshoots on a pop", () => {
    const pop = animation({ type: "pop" });
    const scales = Array.from({ length: 10 }, (_, index) => letterState(pop, 0, 1, index * 0.05 * S).scale);
    expect(Math.max(...scales)).toBeGreaterThan(1);
  });
});

describe("on a clip", () => {
  function text() {
    const added = addTextMaterial(createProject(), "Olá");
    const placed = placeMaterial(added.project, added.materialId, 0);
    return {
      id: placed.segmentId,
      project: updateSegment(placed.project, placed.segmentId, (segment) => {
        segment.letters = animation();
      }),
    };
  }

  it("stays on the first half of a split, because it plays from the start", () => {
    const { project, id } = text();
    const split = splitSegment(project, id, 2 * S)!;
    expect(findSegment(split.project, id)!.segment.letters).toBeDefined();
    expect(findSegment(split.project, split.rightId)!.segment.letters).toBeUndefined();
  });

  it("travels with paste attributes", () => {
    const { project, id } = text();
    const other = addTextMaterial(project, "Oi");
    const placed = placeMaterial(other.project, other.materialId, 20 * S);
    const pasted = pasteAttributes(placed.project, placed.segmentId, copySegment(project, id)!.segment);
    expect(findSegment(pasted, placed.segmentId)!.segment.letters?.type).toBe("rise");
  });
});
