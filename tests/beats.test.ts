import { describe, expect, it } from "vitest";
import { detectBeats } from "../src/core/beats";
import { createProject, findSegment } from "../src/core/model";
import { beatTimes, placeMaterial, setSpeed, snapPoints, splitSegment, trimStart, updateSegment } from "../src/core/ops";

const RATE = 48000;
const S = 1_000_000;

function noise(length: number, amplitude: number): Float32Array {
  const samples = new Float32Array(length);
  let seed = 777;
  for (let index = 0; index < length; index += 1) {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    samples[index] = (seed / 4294967296 - 0.5) * 2 * amplitude;
  }
  return samples;
}

/** Short decaying bursts at a tempo, like a kick drum. */
function drums(bpm: number, seconds: number, background = 0, offset = 0.3): { audio: Float32Array; times: number[] } {
  const audio = noise(seconds * RATE, background);
  const times: number[] = [];
  for (let time = offset; time < seconds - 0.2; time += 60 / bpm) {
    times.push(time);
    const start = Math.round(time * RATE);
    for (let index = 0; index < 4000; index += 1) {
      audio[start + index]! += 0.8 * Math.exp(-index / 800) * Math.sin((2 * Math.PI * 90 * index) / RATE);
    }
  }
  return { audio, times };
}

/** Largest distance from a true beat to the nearest detected one. */
function worstMiss(times: number[], beats: number[]): number {
  return Math.max(...times.map((time) => Math.min(...beats.map((beat) => Math.abs(beat - time)))));
}

describe("beat detection", () => {
  for (const bpm of [80, 100, 120, 150]) {
    it(`finds every beat at ${bpm} BPM`, () => {
      const { audio, times } = drums(bpm, 16);
      const beats = detectBeats([audio], RATE);
      expect(worstMiss(times, beats)).toBeLessThan(0.03);
      expect(Math.abs(beats.length - times.length)).toBeLessThanOrEqual(2);
    });
  }

  it("still finds them under background noise", () => {
    const { audio, times } = drums(120, 16, 0.02);
    expect(worstMiss(times, detectBeats([audio], RATE))).toBeLessThan(0.03);
  });

  it("follows a tempo that drifts", () => {
    const audio = new Float32Array(20 * RATE);
    const times: number[] = [];
    let time = 0.3;
    let gap = 0.5;
    while (time < 19.5) {
      times.push(time);
      const start = Math.round(time * RATE);
      for (let index = 0; index < 4000; index += 1) {
        audio[start + index]! += 0.8 * Math.exp(-index / 800) * Math.sin((2 * Math.PI * 90 * index) / RATE);
      }
      time += gap;
      gap += 0.001;
    }
    expect(worstMiss(times, detectBeats([audio], RATE))).toBeLessThan(0.04);
  });

  it("works on stereo", () => {
    const { audio, times } = drums(120, 12);
    expect(worstMiss(times, detectBeats([audio, audio.slice()], RATE))).toBeLessThan(0.03);
  });

  it("does not invent beats where there are none", () => {
    expect(detectBeats([new Float32Array(10 * RATE)], RATE)).toEqual([]);
    expect(detectBeats([noise(10 * RATE, 0.3)], RATE)).toEqual([]);
    const tone = Float32Array.from({ length: 10 * RATE }, (_, index) => Math.sin(index / 20));
    expect(detectBeats([tone], RATE)).toEqual([]);
  });

  it("needs enough audio to hear a pattern", () => {
    expect(detectBeats([drums(120, 2).audio], RATE)).toEqual([]);
    expect(detectBeats([new Float32Array(100)], RATE)).toEqual([]);
    expect(detectBeats([], RATE)).toEqual([]);
  });
});

describe("beats on a clip", () => {
  function clip() {
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
    const placed = placeMaterial(project, "song", 2 * S);
    return {
      id: placed.segmentId,
      project: updateSegment(placed.project, placed.segmentId, (segment) => {
        segment.beats = [1 * S, 2 * S, 5 * S];
      }),
    };
  }

  it("places them on the timeline", () => {
    const { project, id } = clip();
    expect(beatTimes(findSegment(project, id)!.segment)).toEqual([3 * S, 4 * S, 7 * S]);
  });

  it("stays with the sound after a speed change", () => {
    const { project, id } = clip();
    expect(beatTimes(findSegment(setSpeed(project, id, 2), id)!.segment)).toEqual([2.5 * S, 3 * S, 4.5 * S]);
  });

  it("stays with the sound after a trim", () => {
    const { project, id } = clip();
    const trimmed = trimStart(project, id, 3.5 * S);
    expect(beatTimes(findSegment(trimmed, id)!.segment)).toEqual([4 * S, 7 * S]);
  });

  it("divides between the two parts of a split", () => {
    const { project, id } = clip();
    const split = splitSegment(project, id, 5 * S)!;
    expect(beatTimes(findSegment(split.project, id)!.segment)).toEqual([3 * S, 4 * S]);
    expect(beatTimes(findSegment(split.project, split.rightId)!.segment)).toEqual([7 * S]);
  });

  it("works as a snap point", () => {
    const { project } = clip();
    expect(snapPoints(project, 0)).toContain(4 * S);
  });
});
