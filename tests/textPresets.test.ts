import { describe, expect, it } from "vitest";
import { createProject, findSegment, type TextMaterial } from "../src/core/model";
import { addTextMaterial, placeMaterial, updateMaterial, updateTrack } from "../src/core/ops";
import { addSubtitles } from "../src/core/subtitles";
import { TEXT_PRESETS, applyTextPreset, matchTrackStyle, presetFrom, setSpokenStyle } from "../src/core/textPresets";

function textClip() {
  const added = addTextMaterial(createProject(), "Minha frase");
  const placed = placeMaterial(added.project, added.materialId, 0);
  return { project: placed.project, id: placed.segmentId, materialId: added.materialId };
}

const preset = (id: string) => TEXT_PRESETS.find((item) => item.id === id)!;
const material = (project: ReturnType<typeof textClip>["project"], id: string) =>
  project.materials[id] as TextMaterial;

describe("text presets", () => {
  it("has unique ids", () => {
    expect(new Set(TEXT_PRESETS.map((item) => item.id)).size).toBe(TEXT_PRESETS.length);
  });

  it("changes the look and the animation", () => {
    const { project, id, materialId } = textClip();
    const styled = applyTextPreset(project, id, preset("destaque"));
    expect(material(styled, materialId).background).toBe("#ffd400");
    expect(findSegment(styled, id)!.segment.animIn?.type).toBe("pop");
  });

  it("keeps the words, the size and the alignment", () => {
    const { project, id, materialId } = textClip();
    const sized = updateMaterial(project, materialId, { fontSize: 140, align: "left" } as never);
    const styled = applyTextPreset(sized, id, preset("neon"));
    expect(material(styled, materialId).text).toBe("Minha frase");
    expect(material(styled, materialId).fontSize).toBe(140);
    expect(material(styled, materialId).align).toBe("left");
  });

  it("clears what the previous preset left behind", () => {
    const { project, id, materialId } = textClip();
    const first = applyTextPreset(project, id, preset("titulo"));
    const second = applyTextPreset(first, id, preset("legenda"));
    const result = material(second, materialId);
    expect(result.fontFamily).toBe("Arial");
    expect(result.shadow).toBeUndefined();
    expect(findSegment(second, id)!.segment.animIn).toBeUndefined();
    expect(findSegment(second, id)!.segment.animOut).toBeUndefined();
  });

  it("respects a locked track", () => {
    const { project, id } = textClip();
    const locked = updateTrack(project, project.tracks[0]!.id, { locked: true });
    expect(applyTextPreset(locked, id, preset("neon"))).toBe(locked);
  });

  it("saves a look and brings it back on another clip", () => {
    const { project, id, materialId } = textClip();
    const styled = applyTextPreset(project, id, preset("titulo"));
    const saved = presetFrom(material(styled, materialId), findSegment(styled, id)!.segment, "meu", "Meu");
    expect(saved.style).not.toHaveProperty("text");
    expect(saved.style).not.toHaveProperty("id");
    const other = addTextMaterial(styled, "Outra frase");
    const placed = placeMaterial(other.project, other.materialId, 20_000_000);
    const applied = applyTextPreset(placed.project, placed.segmentId, saved);
    expect(material(applied, other.materialId).fontFamily).toBe("Impact");
    expect(material(applied, other.materialId).text).toBe("Outra frase");
    expect(findSegment(applied, placed.segmentId)!.segment.animIn?.type).toBe("zoom");
  });
});

describe("whole caption tracks", () => {
  function captions() {
    return addSubtitles(createProject(), [
      { start: 0, end: 1_000_000, text: "um", words: [{ text: "um", start: 0, end: 500_000 }] },
      { start: 2_000_000, end: 3_000_000, text: "dois", words: [{ text: "dois", start: 0, end: 500_000 }] },
      { start: 4_000_000, end: 5_000_000, text: "sem tempo" },
    ]);
  }

  it("sets the spoken word style only on captions that have timing", () => {
    const styled = setSpokenStyle(captions(), { mode: "highlight", color: "#ff0000" });
    const texts = Object.values(styled.materials) as TextMaterial[];
    expect(texts.filter((item) => item.spoken)).toHaveLength(2);
    expect(texts.find((item) => item.text === "sem tempo")!.spoken).toBeUndefined();
  });

  it("copies one look to the whole track and keeps each text", () => {
    const project = captions();
    const [first, second] = project.tracks[0]!.segments;
    const styled = applyTextPreset(project, first!.id, preset("destaque"));
    const matched = matchTrackStyle(styled, first!.id);
    const other = material(matched, second!.materialId);
    expect(other.background).toBe("#ffd400");
    expect(other.text).toBe("dois");
    expect(other.timing).toHaveLength(1);
    expect(findSegment(matched, second!.id)!.segment.animIn?.type).toBe("pop");
  });
});
