import { describe, expect, it } from "vitest";
import { createProject, findSegment, type Project } from "../src/core/model";
import { cutSourceRanges, placeMaterial, setSpeed, splitSegment, updateSegment } from "../src/core/ops";
import {
  isHesitation,
  placedWords,
  renameWord,
  spokenRange,
  spokenWord,
  trackWords,
  wordsFromChunks,
  wordsToCues,
  type Word,
} from "../src/core/speech";

const S = 1_000_000;

function clip(words: Word[], at = 0) {
  const project: Project = createProject();
  project.materials.talk = {
    id: "talk",
    kind: "audio",
    name: "fala.wav",
    duration: 20 * S,
    width: 0,
    height: 0,
    hasAudio: true,
  };
  const placed = placeMaterial(project, "talk", at);
  return {
    id: placed.segmentId,
    project: updateSegment(placed.project, placed.segmentId, (segment) => {
      segment.words = words;
    }),
  };
}

const word = (text: string, start: number, end: number): Word => ({ text, start: start * S, end: end * S });

describe("reading model output", () => {
  it("cleans the text and converts to source time", () => {
    const words = wordsFromChunks([{ text: " Olá", timestamp: [1, 1.5] }], 2 * S);
    expect(words).toEqual([{ text: "Olá", start: 3 * S, end: 3.5 * S }]);
  });

  it("fills a missing end from the next word", () => {
    const words = wordsFromChunks(
      [
        { text: "sem", timestamp: [0, null] },
        { text: "fim", timestamp: [1, null] },
      ],
      0,
    );
    expect(words[0]!.end).toBe(1 * S);
    expect(words[1]!.end).toBe(1 * S + 80_000);
  });

  it("gives every word some length, and drops empty ones", () => {
    const words = wordsFromChunks(
      [
        { text: "  ", timestamp: [0, 1] },
        { text: "já", timestamp: [2, 2] },
      ],
      0,
    );
    expect(words).toEqual([{ text: "já", start: 2 * S, end: 2 * S + 80_000 }]);
  });
});

describe("words on the timeline", () => {
  const words = [word("um", 1, 2), word("dois", 3, 4), word("três", 5, 6)];

  it("follows where the clip sits", () => {
    const { project, id } = clip(words, 10 * S);
    expect(placedWords(findSegment(project, id)!.segment)[0]!.at).toBe(11 * S);
  });

  it("follows the speed", () => {
    const { project, id } = clip(words);
    const fast = setSpeed(project, id, 2);
    expect(placedWords(findSegment(fast, id)!.segment).map((item) => item.at)).toEqual([0.5 * S, 1.5 * S, 2.5 * S]);
  });

  it("reads as one text across the pieces of a split", () => {
    const { project, id } = clip(words);
    const split = splitSegment(project, id, 4 * S)!;
    const trackId = split.project.tracks[0]!.id;
    expect(trackWords(split.project, trackId).map((item) => item.text)).toEqual(["um", "dois", "três"]);
  });

  it("forgets words that were cut out, and pulls the rest forward", () => {
    const { project, id } = clip(words);
    const cut = cutSourceRanges(project, id, [{ start: 3 * S, end: 4 * S }]);
    const placed = trackWords(cut, cut.tracks[0]!.id);
    expect(placed.map((item) => item.text)).toEqual(["um", "três"]);
    expect(placed[1]!.at).toBe(4 * S);
  });
});

describe("captions from words", () => {
  const placed = (words: Word[]) => {
    const { project, id } = clip(words);
    return placedWords(findSegment(project, id)!.segment);
  };

  it("puts words together with their timing", () => {
    expect(wordsToCues(placed([word("bom", 1, 1.3), word("dia", 1.4, 1.8)]))).toMatchObject([
      { start: 1 * S, end: 1.8 * S, text: "bom dia" },
    ]);
  });

  it("breaks at the end of a sentence", () => {
    const cues = wordsToCues(placed([word("Oi.", 0, 0.5), word("Tudo", 0.6, 1), word("bem?", 1, 1.4)]));
    expect(cues.map((cue) => cue.text)).toEqual(["Oi.", "Tudo bem?"]);
  });

  it("breaks at a long pause", () => {
    const cues = wordsToCues(placed([word("antes", 0, 0.5), word("depois", 3, 3.5)]));
    expect(cues).toHaveLength(2);
  });

  it("keeps each caption short enough to read", () => {
    const many = Array.from({ length: 30 }, (_, index) => word("palavra", index * 0.4, index * 0.4 + 0.35));
    const cues = wordsToCues(placed(many));
    expect(cues.length).toBeGreaterThan(4);
    expect(Math.max(...cues.map((cue) => cue.text.length))).toBeLessThanOrEqual(42);
  });

  it("gives nothing for no words", () => {
    expect(wordsToCues([])).toEqual([]);
  });
});

describe("the word being said", () => {
  const timing = [word("bom", 0, 0.4), word("dia", 0.5, 1), word("dia", 1.2, 1.6)];

  it("follows the time and holds until the next word", () => {
    expect(spokenWord(timing, 0)).toBe(0);
    expect(spokenWord(timing, 0.45 * S)).toBe(0);
    expect(spokenWord(timing, 0.5 * S)).toBe(1);
    expect(spokenWord(timing, 5 * S)).toBe(2);
  });

  it("waits for the first word", () => {
    expect(spokenWord([word("oi", 1, 2)], 0)).toBe(-1);
  });

  it("finds a repeated word in the right place", () => {
    expect(spokenRange("bom dia dia", timing, 2)).toEqual({ start: 8, end: 11 });
  });

  it("gives up quietly when the text was edited", () => {
    expect(spokenRange("boa tarde", timing, 1)).toBeNull();
  });

  it("travels with the captions made from speech", () => {
    const { project, id } = clip([word("bom", 1, 1.3), word("dia", 1.4, 1.8)]);
    const [cue] = wordsToCues(placedWords(findSegment(project, id)!.segment));
    expect(cue!.words).toEqual([
      { text: "bom", start: 0, end: 0.3 * S },
      { text: "dia", start: 0.4 * S, end: 0.8 * S },
    ]);
  });
});

describe("correcting a word", () => {
  it("changes only that word", () => {
    const { project, id } = clip([word("mâncica", 1, 2), word("boa", 3, 4)]);
    const fixed = updateSegment(project, id, (segment) => renameWord(segment, 1 * S, "música"));
    expect(findSegment(fixed, id)!.segment.words!.map((item) => item.text)).toEqual(["música", "boa"]);
  });
});

describe("hesitations", () => {
  it("recognises them with any case or punctuation", () => {
    for (const text of ["hum", "Hmm,", "ahn...", "Uh"]) expect(isHesitation(word(text, 0, 1))).toBe(true);
  });

  it("keeps words that carry meaning", () => {
    for (const text of ["é", "né", "tipo", "humano", "a"]) expect(isHesitation(word(text, 0, 1))).toBe(false);
  });
});
