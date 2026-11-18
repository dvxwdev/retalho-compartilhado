import { describe, expect, it } from "vitest";
import { createProject } from "../src/core/model";
import { addTextMaterial, placeMaterial, updateTrack } from "../src/core/ops";
import { resolveFrame } from "../src/core/resolve";
import {
  addSubtitles,
  decodeSubtitleText,
  formatSrt,
  parseSrt,
  subtitleCues,
} from "../src/core/subtitles";

const S = 1_000_000;

const SAMPLE = `1
00:00:01,000 --> 00:00:03,500
Olá, mundo

2
00:00:04,000 --> 00:00:05,250
Duas
linhas
`;

describe("reading srt", () => {
  it("reads timing and multi-line text", () => {
    expect(parseSrt(SAMPLE)).toEqual([
      { start: 1 * S, end: 3.5 * S, text: "Olá, mundo" },
      { start: 4 * S, end: 5.25 * S, text: "Duas\nlinhas" },
    ]);
  });

  it("accepts a byte order mark, Windows line ends, dots and short fractions", () => {
    const content = "﻿1\r\n00:00:01.5 --> 00:00:02.25\r\nOi\r\n\r\n";
    expect(parseSrt(content)).toEqual([{ start: 1.5 * S, end: 2.25 * S, text: "Oi" }]);
  });

  it("removes formatting tags", () => {
    const content = "1\n00:00:01,000 --> 00:00:02,000\n{\\an8}<i>Oi</i> <b>você</b>\n";
    expect(parseSrt(content)[0]!.text).toBe("Oi você");
  });

  it("skips broken blocks and keeps the rest", () => {
    const content = `lixo\n\n2\n00:00:05,000 --> 00:00:04,000\nAo contrário\n\n3\n00:00:06,000 --> 00:00:07,000\n\n4\n00:00:08,000 --> 00:00:09,000\nCerto\n`;
    expect(parseSrt(content).map((cue) => cue.text)).toEqual(["Certo"]);
  });

  it("decodes Windows-1252 files as well as UTF-8", () => {
    const latin = new Uint8Array([0x61, 0xe7, 0xe3, 0x6f]);
    expect(decodeSubtitleText(latin.buffer)).toBe("ação");
    expect(decodeSubtitleText(new TextEncoder().encode("ação").buffer as ArrayBuffer)).toBe("ação");
  });
});

describe("writing srt", () => {
  it("survives a round trip", () => {
    const cues = parseSrt(SAMPLE);
    expect(parseSrt(formatSrt(cues))).toEqual(cues);
  });

  it("formats hours and milliseconds", () => {
    const text = formatSrt([{ start: 3_661_250_000, end: 3_662_000_000, text: "Oi" }]);
    expect(text).toBe("1\n01:01:01,250 --> 01:01:02,000\nOi\n");
  });

  it("lists texts from every visible track in time order", () => {
    const first = addTextMaterial(createProject(), "segundo");
    const placedFirst = placeMaterial(first.project, first.materialId, 5 * S);
    const second = addTextMaterial(placedFirst.project, "primeiro");
    const placedSecond = placeMaterial(second.project, second.materialId, 1 * S);
    expect(subtitleCues(placedSecond.project).map((cue) => cue.text)).toEqual(["primeiro", "segundo"]);
    const hidden = updateTrack(placedSecond.project, placedSecond.project.tracks[0]!.id, { hidden: true });
    expect(subtitleCues(hidden).map((cue) => cue.text)).toEqual(["primeiro"]);
  });
});

describe("placing subtitles", () => {
  it("puts cues on one new track, low in the frame", () => {
    const project = addSubtitles(createProject(), parseSrt(SAMPLE));
    expect(project.tracks).toHaveLength(1);
    const [track] = project.tracks;
    expect(track!.type).toBe("text");
    expect(track!.segments.map((segment) => segment.target)).toEqual([
      { start: 1 * S, duration: 2.5 * S },
      { start: 4 * S, duration: 1.25 * S },
    ]);
    const [layer] = resolveFrame(project, 2 * S);
    expect(layer!.transform.y).toBeLessThan(-0.5);
    expect(layer!.material.kind === "text" && layer!.material.text).toBe("Olá, mundo");
  });

  it("gives each cue its own text", () => {
    const project = addSubtitles(createProject(), parseSrt(SAMPLE));
    const ids = project.tracks[0]!.segments.map((segment) => segment.materialId);
    expect(new Set(ids).size).toBe(2);
  });

  it("ends a cue where the next begins, so the track never overlaps", () => {
    const project = addSubtitles(createProject(), [
      { start: 2 * S, end: 3 * S, text: "b" },
      { start: 0, end: 4 * S, text: "a" },
    ]);
    expect(project.tracks[0]!.segments.map((segment) => segment.target)).toEqual([
      { start: 0, duration: 2 * S },
      { start: 2 * S, duration: 1 * S },
    ]);
  });

  it("leaves the project alone when there is nothing to add", () => {
    const project = createProject();
    expect(addSubtitles(project, [])).toBe(project);
  });
});
