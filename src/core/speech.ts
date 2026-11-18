import { segmentEnd, type Project, type Segment, type Us } from "./model";
import type { Cue } from "./subtitles";

/** Highlight colours the word being said; single shows only that word. */
export interface SpokenStyle {
  mode: "highlight" | "single";
  color: string;
  /** Grows the word being said, from 1, its normal size. */
  scale?: number;
  /** A rounded box behind the word being said; empty or absent draws none. */
  box?: string;
}

export const MAX_SPOKEN_SCALE = 1.6;

/** One spoken word, in source time so it stays on the sound through edits. */
export interface Word {
  text: string;
  start: Us;
  end: Us;
}

/** As the speech model reports them: seconds, and an end that can be missing. */
export interface SpeechChunk {
  text: string;
  timestamp: [number, number | null];
}

const MAX_CAPTION_CHARACTERS = 42;
const MAX_CAPTION_GAP: Us = 700_000;
const MIN_WORD_LENGTH: Us = 80_000;
const SENTENCE_END = /[.!?…]$/;

/** Sounds with no meaning of their own. Words like "né" stay, since they can be intended. */
const HESITATIONS = new Set(["ah", "ahn", "ãh", "eh", "ehh", "éé", "hm", "hmm", "hum", "humm", "uh", "uhm", "um", "ã"]);

/** Turns model output into words, starting at a source time. */
export function wordsFromChunks(chunks: SpeechChunk[], start: Us): Word[] {
  const words: Word[] = [];
  chunks.forEach(({ text, timestamp: [from, to] }, index) => {
    const clean = text.trim();
    if (!clean) return;
    const next = chunks[index + 1]?.timestamp[0];
    const wordStart = start + Math.round(from * 1_000_000);
    const end = to ?? next ?? from + MIN_WORD_LENGTH / 1_000_000;
    words.push({
      text: clean,
      start: wordStart,
      end: Math.max(start + Math.round(end * 1_000_000), wordStart + MIN_WORD_LENGTH),
    });
  });
  return words;
}

/** A word as it stands on the timeline, with the clip it belongs to. */
export interface PlacedWord extends Word {
  segmentId: string;
  /** Where it plays on the timeline. */
  at: Us;
  until: Us;
}

/** The words still in a clip after trims and cuts, placed on the timeline. */
export function placedWords(segment: Segment): PlacedWord[] {
  const { start, duration } = segment.source;
  if (segment.reversed) return [];
  const place = (time: Us) => Math.round(segment.target.start + (time - start) / segment.speed);
  return (segment.words ?? [])
    .filter((word) => word.start >= start && word.start < start + duration)
    .map((word) => ({
      ...word,
      segmentId: segment.id,
      at: place(word.start),
      until: Math.min(place(word.end), segmentEnd(segment)),
    }));
}

/** Every word on a track in playing order, so pieces of a cut clip read as one text. */
export function trackWords(project: Project, trackId: string): PlacedWord[] {
  const track = project.tracks.find((item) => item.id === trackId);
  return (track?.segments ?? []).flatMap(placedWords);
}

/** Groups words into captions short enough to read, breaking at pauses and sentence ends. */
export function wordsToCues(words: PlacedWord[]): Cue[] {
  const cues: Cue[] = [];
  let current: PlacedWord[] = [];
  const flush = () => {
    if (current.length === 0) return;
    const start = current[0]!.at;
    cues.push({
      start,
      end: current[current.length - 1]!.until,
      text: current.map((word) => word.text).join(" "),
      words: current.map((word) => ({ text: word.text, start: word.at - start, end: word.until - start })),
    });
    current = [];
  };
  for (const word of words) {
    const last = current[current.length - 1];
    const length = current.reduce((total, item) => total + item.text.length + 1, word.text.length);
    if (last && (length > MAX_CAPTION_CHARACTERS || word.at - last.until > MAX_CAPTION_GAP)) flush();
    current.push(word);
    if (SENTENCE_END.test(word.text)) flush();
  }
  flush();
  return cues;
}

/** The word being said at a time, which stays until the next one begins. */
export function spokenWord(timing: Word[], time: Us): number {
  let index = -1;
  for (let word = 0; word < timing.length && timing[word]!.start <= time; word += 1) index = word;
  return index;
}

/** Where a timed word sits in the text, for colouring it. Null if it was edited away. */
export function spokenRange(text: string, timing: Word[], index: number): { start: number; end: number } | null {
  let from = 0;
  for (let word = 0; word <= index; word += 1) {
    const at = text.indexOf(timing[word]!.text, from);
    if (at < 0) return null;
    if (word === index) return { start: at, end: at + timing[word]!.text.length };
    from = at + timing[word]!.text.length;
  }
  return null;
}

/** Corrects a word in every piece of a clip that holds it. */
export function renameWord(segment: Segment, start: Us, text: string): void {
  segment.words = segment.words?.map((word) => (word.start === start ? { ...word, text } : word));
}

export function isHesitation(word: Word): boolean {
  return HESITATIONS.has(word.text.toLowerCase().replace(/[.,!?…;:]/g, ""));
}
