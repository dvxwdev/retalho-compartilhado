import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { importCapCutDraft, isCapCutDraft } from "../src/core/importDraft";
import { projectDuration } from "../src/core/model";
import { resolveFrame } from "../src/core/resolve";

function clip(extra = {}) {
  return {
    scale: { x: 0.5, y: 0.5 },
    rotation: 10,
    transform: { x: 0.25, y: -0.5 },
    flip: { vertical: false, horizontal: false },
    alpha: 0.8,
    ...extra,
  };
}

/** Synthetic draft shaped like what CapCut 9.1 writes. */
const draft = {
  name: "",
  fps: 30,
  canvas_config: { ratio: "original", width: 1080, height: 1920 },
  materials: {
    videos: [
      { id: "v1", type: "video", duration: 8_000_000, path: "C:/m/a.mp4", width: 1440, height: 2560, has_audio: true },
      { id: "p1", type: "photo", duration: 5_000_000, path: "C:\\m\\b.png", width: 800, height: 600 },
    ],
    audios: [{ id: "a1", type: "extract_music", name: "x.m4a", duration: 9_000_000, path: "C:/m/x.m4a" }],
    texts: [{ id: "t1", content: '{"text":"olá","styles":[]}', text_color: "#00ff18", font_size: 18, bold_width: 0.008 }],
    text_templates: [{ id: "tt1", text_info_resources: [{ text_material_id: "t1" }] }],
    transitions: [{ id: "tr1", duration: 466_666 }],
    effects: [
      { id: "e1", type: "brightness", value: -0.5 },
      { id: "e2", type: "sharpen", value: 0.3 },
    ],
    video_effects: [{ id: "ve1" }],
    material_animations: [{ id: "an1", animations: [] }],
  },
  tracks: [
    {
      type: "video",
      segments: [
        {
          material_id: "v1",
          target_timerange: { start: 0, duration: 2_000_000 },
          source_timerange: { start: 1_000_000, duration: 2_000_000 },
          speed: 1,
          volume: 1.5,
          clip: clip(),
          extra_material_refs: ["tr1", "e1", "e2", "an1"],
          common_keyframes: [
            {
              property_type: "KFTypeScaleX",
              keyframe_list: [
                { time_offset: 500_000, values: [2] },
                { time_offset: 0, values: [1] },
              ],
            },
            { property_type: "KFTypeUnknown", keyframe_list: [{ time_offset: 0, values: [9] }] },
          ],
        },
        {
          material_id: "p1",
          target_timerange: { start: 2_000_000, duration: 1_000_000 },
          source_timerange: { start: 0, duration: 1_000_000 },
          clip: clip(),
          extra_material_refs: [],
        },
      ],
    },
    { type: "effect", segments: [{ material_id: "ve1", target_timerange: { start: 0, duration: 1 } }] },
    {
      type: "text",
      segments: [
        { material_id: "t1", target_timerange: { start: 0, duration: 1_000_000 }, clip: clip() },
        { material_id: "tt1", target_timerange: { start: 1_000_000, duration: 1_000_000 }, clip: clip() },
      ],
    },
    {
      type: "audio",
      segments: [
        {
          material_id: "a1",
          target_timerange: { start: 0, duration: 3_000_000 },
          source_timerange: { start: 500_000, duration: 3_000_000 },
          volume: 0.2,
        },
      ],
    },
  ],
};

describe("draft flip", () => {
  it("keeps a mirrored clip", () => {
    const { project } = importCapCutDraft({
      tracks: [
        {
          type: "video",
          segments: [
            {
              material_id: "v",
              target_timerange: { start: 0, duration: 1_000_000 },
              source_timerange: { start: 0, duration: 1_000_000 },
              clip: clip({ flip: { horizontal: true, vertical: false } }),
            },
          ],
        },
      ],
      canvas_config: { width: 1920, height: 1080 },
      materials: { videos: [{ id: "v", type: "video", path: "a.mp4", duration: 1_000_000 }] },
    });
    const [segment] = project.tracks[0]!.segments;
    expect(segment!.flipX).toBe(true);
    expect(segment!.flipY).toBeUndefined();
  });
});

describe("draft markers", () => {
  it("drops the copies CapCut makes when a clip is split", () => {
    const mark = { time_range: { start: 5_000_000, duration: 0 }, color: "#00c1cd", title: "Marcador 01" };
    const other = { time_range: { start: 1_000_000, duration: 0 }, title: "Marcador 02" };
    const { project } = importCapCutDraft({
      tracks: [],
      canvas_config: { width: 1920, height: 1080 },
      materials: { time_marks: [{ id: "a", mark_items: [mark, other] }, { id: "b", mark_items: [mark] }] },
    });
    expect(project.markers!.map((item) => [item.label, item.time, item.color])).toEqual([
      ["Marcador 02", 1_000_000, "#2fb8c6"],
      ["Marcador 01", 5_000_000, "#00c1cd"],
    ]);
  });
});

describe("importCapCutDraft", () => {
  const { project, warnings, offlineFiles } = importCapCutDraft(draft);
  const [video, text, audio] = project.tracks;

  it("recognises drafts and rejects other JSON", () => {
    expect(isCapCutDraft(draft)).toBe(true);
    expect(isCapCutDraft({ tracks: [] })).toBe(false);
    expect(isCapCutDraft(null)).toBe(false);
  });

  it("keeps canvas, timing and transform", () => {
    expect(project.canvas).toEqual({ width: 1080, height: 1920 });
    expect(projectDuration(project)).toBe(3_000_000);
    const [first] = video!.segments;
    expect(first!.source).toEqual({ start: 1_000_000, duration: 2_000_000 });
    expect(first!.volume).toBe(1.5);
    expect(first!.transform).toEqual({ x: 0.25, y: -0.5, scale: 0.5, rotation: 10, opacity: 0.8 });
  });

  it("converts keyframes, sorted, ignoring unknown properties", () => {
    expect(video!.segments[0]!.keyframes).toEqual({
      scale: [
        { offset: 0, value: 1 },
        { offset: 500_000, value: 2 },
      ],
    });
  });

  it("maps adjustments and transitions", () => {
    const [first] = video!.segments;
    expect(first!.adjust.brightness).toBe(-50);
    expect(first!.transitionOut).toEqual({ type: "fade", duration: 466_666 });
  });

  it("resolves subtitle templates to their text", () => {
    expect(text!.segments).toHaveLength(2);
    const material = project.materials[text!.segments[1]!.materialId]!;
    expect(material).toMatchObject({ kind: "text", text: "olá", color: "#00ff18", bold: true });
  });

  it("marks media offline with the file name from either path style", () => {
    expect(Object.values(offlineFiles).sort()).toEqual(["a.mp4", "b.png", "x.m4a"]);
    const photo = project.materials[video!.segments[1]!.materialId]!;
    expect(photo).toMatchObject({ kind: "image", offline: true });
    expect(audio!.segments[0]!.source.start).toBe(500_000);
  });

  it("reports what it could not keep", () => {
    expect(warnings).toContain("1× faixas de efeito");
    expect(warnings).toContain('1× ajustes "sharpen"');
    expect(warnings).toContain("1× transições (convertidas para fade)");
    expect(warnings).toContain("1× modelos de legenda (só o texto foi mantido)");
  });

  it("produces a project the frame resolver can render", () => {
    expect(resolveFrame(project, 500_000).map((layer) => layer.material.kind)).toEqual(["video", "text"]);
  });
});

const realDraft = process.env.RETALHO_REAL_DRAFT;

describe.skipIf(!realDraft || !existsSync(realDraft))("real draft", () => {
  it("imports without losing clips", () => {
    const source = JSON.parse(readFileSync(realDraft!, "utf8"));
    const { project, warnings } = importCapCutDraft(source);
    const expected = source.tracks
      .filter((track: { type: string }) => track.type !== "effect")
      .reduce((sum: number, track: { segments: unknown[] }) => sum + track.segments.length, 0);
    const actual = project.tracks.reduce((sum, track) => sum + track.segments.length, 0);
    expect(actual).toBe(expected);
    expect(projectDuration(project)).toBe(source.duration);
    console.log(warnings.join("\n"));
  });
});
