import { describe, expect, it } from "vitest";
import { createProject, findSegment } from "../src/core/model";
import { MOTION_TEMPLATES, addMotionTemplate } from "../src/core/motionTemplates";
import { groupMembers, replaceInTexts } from "../src/core/ops";
import { resolveFrame } from "../src/core/resolve";
import { addSubtitles } from "../src/core/subtitles";

const S = 1_000_000;

describe("motion templates", () => {
  for (const { value, label } of MOTION_TEMPLATES) {
    it(`adds ${label} as one group, at the cursor`, () => {
      const { project, segmentIds } = addMotionTemplate(createProject(), value, 2 * S);
      expect(segmentIds.length).toBeGreaterThan(1);
      expect(groupMembers(project, segmentIds[0]!).sort()).toEqual([...segmentIds].sort());
      for (const id of segmentIds) expect(findSegment(project, id)!.segment.target.start).toBe(2 * S);
      expect(resolveFrame(project, 3.5 * S).length).toBe(segmentIds.length);
    });
  }

  it("keeps pieces apart so they can overlap in time", () => {
    const { project } = addMotionTemplate(createProject(), "endCard", 0);
    expect(project.tracks.length).toBeGreaterThan(1);
    for (const track of project.tracks) expect(track.segments).toHaveLength(1);
  });

  it("draws the background of a card under its text", () => {
    const { project } = addMotionTemplate(createProject(), "endCard", 0);
    const [first] = resolveFrame(project, S);
    expect(first!.material.kind).toBe("shape");
  });

  it("lets two templates coexist", () => {
    const first = addMotionTemplate(createProject(), "title", 0);
    const second = addMotionTemplate(first.project, "lowerThird", 0);
    expect(groupMembers(second.project, first.segmentIds[0]!)).toHaveLength(2);
  });
});

describe("find and replace in texts", () => {
  const captions = () =>
    addSubtitles(createProject(), [
      { start: 0, end: S, text: "O Retalo edita" },
      { start: 2 * S, end: 3 * S, text: "Retalo e retalo" },
      { start: 4 * S, end: 5 * S, text: "outra coisa" },
    ]);
  const texts = (project: ReturnType<typeof captions>) =>
    project.tracks[0]!.segments.map((segment) => (project.materials[segment.materialId] as { text: string }).text);

  it("changes every match, in every text, keeping the case it was asked for", () => {
    const { project, count } = replaceInTexts(captions(), "Retalo", "Retalho");
    expect(texts(project)).toEqual(["O Retalho edita", "Retalho e retalo", "outra coisa"]);
    expect(count).toBe(2);
  });

  it("changes nothing when there is no match", () => {
    const project = captions();
    expect(replaceInTexts(project, "xyz", "abc")).toEqual({ project, count: 0 });
  });

  it("ignores an empty search", () => {
    const project = captions();
    expect(replaceInTexts(project, "", "abc").project).toBe(project);
  });

  it("keeps word timing in step with the correction", () => {
    const base = addSubtitles(createProject(), [
      { start: 0, end: S, text: "mâncica boa", words: [{ text: "mâncica", start: 0, end: S / 2 }, { text: "boa", start: S / 2, end: S }] },
    ]);
    const { project } = replaceInTexts(base, "mâncica", "música");
    const [material] = Object.values(project.materials) as { timing: { text: string }[] }[];
    expect(material!.timing.map((word) => word.text)).toEqual(["música", "boa"]);
  });
});
