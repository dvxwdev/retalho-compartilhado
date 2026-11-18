import { describe, expect, it } from "vitest";
import { audioPlan } from "../src/core/resolve";
import { createProject, findSegment } from "../src/core/model";
import { copySegment, pasteAttributes, placeMaterial, setSpeed, updateSegment } from "../src/core/ops";
import { timeStretch } from "../src/core/stretch";

const RATE = 48000;

function sine(seconds: number, frequency: number): Float32Array {
  const samples = new Float32Array(seconds * RATE);
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = 0.5 * Math.sin((2 * Math.PI * frequency * index) / RATE);
  }
  return samples;
}

/** Frequency from zero crossings, skipping the edges. */
function frequencyOf(samples: Float32Array): number {
  const from = Math.floor(samples.length * 0.1);
  const to = Math.floor(samples.length * 0.9);
  let crossings = 0;
  for (let index = from + 1; index < to; index += 1) {
    if (samples[index - 1]! < 0 && samples[index]! >= 0) crossings += 1;
  }
  return crossings / ((to - from) / RATE);
}

function rms(samples: Float32Array): number {
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  return Math.sqrt(sum / samples.length);
}

describe("time stretch", () => {
  for (const [rate, label] of [[2, "faster"], [0.5, "slower"], [1.5, "a little faster"]] as const) {
    it(`keeps the pitch when ${label}`, () => {
      const output = Math.round((4 * RATE) / rate);
      const [result] = timeStretch([sine(4, 220)], rate, output);
      expect(result!.length).toBe(output);
      expect(frequencyOf(result!)).toBeGreaterThan(218);
      expect(frequencyOf(result!)).toBeLessThan(222);
    });
  }

  it("keeps the level", () => {
    const source = sine(4, 440);
    const [result] = timeStretch([source], 2, 2 * RATE);
    expect(rms(result!.subarray(RATE / 2, RATE))).toBeCloseTo(rms(source), 1);
  });

  it("keeps events at their new times", () => {
    const clicks = new Float32Array(4 * RATE);
    for (const second of [1, 2, 3]) clicks.fill(0.9, second * RATE, second * RATE + 200);
    const [result] = timeStretch([clicks], 2, 2 * RATE);
    const energyAt = (second: number) => {
      const center = Math.round(second * RATE);
      return rms(result!.subarray(center - 2400, center + 2400));
    };
    expect(energyAt(1)).toBeGreaterThan(0.02);
    expect(energyAt(0.75)).toBeLessThan(0.001);
  });

  it("moves channels together", () => {
    const left = sine(2, 300);
    const [a, b] = timeStretch([left, left.slice()], 2, RATE);
    expect(a).toEqual(b);
  });

  it("copes with audio shorter than one window", () => {
    const [result] = timeStretch([new Float32Array(100).fill(0.5)], 2, 50);
    expect(result!.length).toBe(50);
  });
});

describe("in the audio plan", () => {
  function clip() {
    const project = createProject();
    project.materials.song = {
      id: "song",
      kind: "audio",
      name: "song.wav",
      duration: 10_000_000,
      width: 0,
      height: 0,
      hasAudio: true,
    };
    return placeMaterial(project, "song", 0);
  }

  it("keeps the pitch unless told otherwise", () => {
    const { project, segmentId } = clip();
    const fast = setSpeed(project, segmentId, 2);
    expect(audioPlan(fast, 0)[0]!.keepPitch).toBe(true);
    const changed = updateSegment(fast, segmentId, (segment) => {
      segment.changePitch = true;
    });
    expect(audioPlan(changed, 0)[0]!.keepPitch).toBe(false);
  });

  it("says which part of the source the event belongs to, even when it starts late", () => {
    const { project, segmentId } = clip();
    const fast = setSpeed(project, segmentId, 2);
    const [event] = audioPlan(fast, 2_000_000);
    expect(event!.source).toEqual({ start: 0, duration: 10_000_000 });
    expect(event!.length).toBe(5_000_000);
    expect(event!.skipped).toBe(2_000_000);
  });

  it("travels with paste attributes", () => {
    const first = clip();
    const second = placeMaterial(first.project, "song", 20_000_000);
    const changed = updateSegment(second.project, first.segmentId, (segment) => {
      segment.changePitch = true;
    });
    const pasted = pasteAttributes(changed, second.segmentId, copySegment(changed, first.segmentId)!.segment);
    expect(findSegment(pasted, second.segmentId)!.segment.changePitch).toBe(true);
  });
});
