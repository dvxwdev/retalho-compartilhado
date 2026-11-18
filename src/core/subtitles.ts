import { makeSegment } from "./ops";
import { newId, segmentEnd, type Project, type Segment, type TextMaterial, type Track, type Us } from "./model";
import type { Word } from "./speech";

export interface Cue {
  start: Us;
  end: Us;
  text: string;
  /** Word timing from the start of the cue, when it came from speech. */
  words?: Word[];
}

/** Where subtitles sit by default, near the bottom of the frame. */
const SUBTITLE_Y = -0.72;
const SUBTITLE_FONT_SIZE = 64;
const SUBTITLE_STROKE = 4;

const TIMING =
  /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/;

function toMicroseconds(hours: string, minutes: string, seconds: string, fraction: string): Us {
  const milliseconds = Number(fraction.padEnd(3, "0"));
  return ((Number(hours) * 60 + Number(minutes)) * 60 + Number(seconds)) * 1_000_000 + milliseconds * 1000;
}

/** Subtitle files from older tools are often Windows-1252, which is invalid UTF-8. */
export function decodeSubtitleText(bytes: ArrayBuffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

/** Reads cues in file order, skipping blocks that have no valid timing or no text. */
export function parseSrt(content: string): Cue[] {
  const cues: Cue[] = [];
  const blocks = content.replace(/^﻿/, "").replace(/\r\n?/g, "\n").split(/\n\s*\n/);
  for (const block of blocks) {
    const lines = block.split("\n");
    const timingLine = lines.findIndex((line) => TIMING.test(line));
    if (timingLine < 0) continue;
    const match = TIMING.exec(lines[timingLine]!)!;
    const [, h1, m1, s1, f1, h2, m2, s2, f2] = match;
    const start = toMicroseconds(h1!, m1!, s1!, f1!);
    const end = toMicroseconds(h2!, m2!, s2!, f2!);
    const text = lines
      .slice(timingLine + 1)
      .join("\n")
      .replace(/<[^>]*>|\{\\[^}]*\}/g, "")
      .trim();
    if (text && end > start) cues.push({ start, end, text });
  }
  return cues;
}

function formatTimestamp(time: Us): string {
  const milliseconds = Math.round(time / 1000);
  const pad = (value: number, size = 2) => String(value).padStart(size, "0");
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor(milliseconds / 60_000) % 60;
  const seconds = Math.floor(milliseconds / 1000) % 60;
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)},${pad(milliseconds % 1000, 3)}`;
}

export function formatSrt(cues: Cue[]): string {
  return cues
    .map(({ start, end, text }, index) =>
      `${index + 1}\n${formatTimestamp(start)} --> ${formatTimestamp(end)}\n${text}\n`,
    )
    .join("\n");
}

/** Every text clip with its content, in time order. */
export function subtitleClips(project: Project): { segment: Segment; material: TextMaterial }[] {
  const clips: { segment: Segment; material: TextMaterial }[] = [];
  for (const track of project.tracks) {
    if (track.type !== "text") continue;
    for (const segment of track.segments) {
      const material = project.materials[segment.materialId];
      if (material?.kind === "text") clips.push({ segment, material });
    }
  }
  return clips.sort((a, b) => a.segment.target.start - b.segment.target.start);
}

/** Every visible text on the timeline, in time order. */
export function subtitleCues(project: Project): Cue[] {
  const cues: Cue[] = [];
  for (const track of project.tracks) {
    if (track.type !== "text" || track.hidden) continue;
    for (const segment of track.segments) {
      const material = project.materials[segment.materialId];
      if (material?.kind !== "text" || !material.text.trim()) continue;
      cues.push({ start: segment.target.start, end: segmentEnd(segment), text: material.text.trim() });
    }
  }
  return cues.sort((a, b) => a.start - b.start);
}

/**
 * Adds cues as clips on a new text track. A track cannot overlap, so a cue that
 * runs into the next one ends where the next one starts.
 */
export function addSubtitles(project: Project, cues: Cue[]): Project {
  const sorted = [...cues].sort((a, b) => a.start - b.start);
  const materials = { ...project.materials };
  const track: Track = { id: newId(), type: "text", name: "Legendas", muted: false, hidden: false, segments: [] };

  sorted.forEach(({ start, end, text, words }, index) => {
    const following = sorted[index + 1];
    const duration = Math.min(end, following?.start ?? end) - start;
    if (duration <= 0) return;
    const material: TextMaterial = {
      id: newId(),
      kind: "text",
      text,
      fontFamily: "Arial",
      fontSize: SUBTITLE_FONT_SIZE,
      color: "#ffffff",
      bold: true,
      italic: false,
      align: "center",
      strokeColor: "#000000",
      strokeWidth: SUBTITLE_STROKE,
      background: "",
      ...(words ? { timing: words } : {}),
    };
    materials[material.id] = material;
    const segment = makeSegment(material, start);
    segment.target.duration = duration;
    segment.source.duration = duration;
    segment.transform.y = SUBTITLE_Y;
    track.segments.push(segment);
  });

  return track.segments.length ? { ...project, materials, tracks: [...project.tracks, track] } : project;
}
