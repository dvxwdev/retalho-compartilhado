import { describe, expect, it } from "vitest";
import { reduceNoise } from "../src/core/denoise";
import { fft } from "../src/core/fft";
import { createProject, findSegment } from "../src/core/model";
import { copySegment, pasteAttributes, placeMaterial, updateSegment } from "../src/core/ops";
import { audioPlan } from "../src/core/resolve";

const RATE = 48000;

function noise(length: number, amplitude: number): Float32Array {
  const samples = new Float32Array(length);
  let seed = 12345;
  for (let index = 0; index < length; index += 1) {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    samples[index] = (seed / 4294967296 - 0.5) * 2 * amplitude;
  }
  return samples;
}

/** One second of noise alone, then a tone over the same noise. */
function recording(): Float32Array {
  const samples = noise(3 * RATE, 0.03);
  for (let index = RATE; index < samples.length; index += 1) {
    samples[index]! += 0.3 * Math.sin((2 * Math.PI * 1000 * index) / RATE);
  }
  return samples;
}

function rms(samples: Float32Array): number {
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  return Math.sqrt(sum / samples.length);
}

const db = (ratio: number) => 20 * Math.log10(ratio);

describe("fft", () => {
  it("finds a tone in its own bin", () => {
    const real = new Float64Array(64);
    const imaginary = new Float64Array(64);
    for (let index = 0; index < 64; index += 1) real[index] = Math.cos((2 * Math.PI * 5 * index) / 64);
    fft(real, imaginary);
    expect(Math.hypot(real[5]!, imaginary[5]!)).toBeCloseTo(32);
    expect(Math.hypot(real[6]!, imaginary[6]!)).toBeCloseTo(0);
  });

  it("returns to the start when inverted", () => {
    const real = Float64Array.from({ length: 32 }, (_, index) => Math.sin(index));
    const original = real.slice();
    const imaginary = new Float64Array(32);
    fft(real, imaginary);
    fft(real, imaginary, true);
    real.forEach((value, index) => expect(value).toBeCloseTo(original[index]!));
  });
});

describe("noise reduction", () => {
  it("lowers noise by a lot and leaves the tone at its level", () => {
    const source = recording();
    const [clean] = reduceNoise([source], 0.8);
    const noiseDrop = db(rms(clean!.subarray(RATE / 4, RATE - RATE / 4)) / rms(source.subarray(RATE / 4, RATE - RATE / 4)));
    expect(noiseDrop).toBeLessThan(-10);
    const toneChange = db(rms(clean!.subarray(RATE + RATE / 4)) / rms(source.subarray(RATE + RATE / 4)));
    expect(Math.abs(toneChange)).toBeLessThan(1);
  });

  it("reduces more when stronger", () => {
    const source = recording();
    const level = (strength: number) => rms(reduceNoise([source], strength)[0]!.subarray(RATE / 4, RATE / 2));
    expect(level(0.9)).toBeLessThan(level(0.3));
  });

  it("keeps the length and every channel", () => {
    const source = recording();
    const result = reduceNoise([source, source.slice()], 0.5);
    expect(result).toHaveLength(2);
    expect(result[0]!.length).toBe(source.length);
  });

  it("does not touch the start of the clip's timing", () => {
    const source = recording();
    const [clean] = reduceNoise([source], 0.5);
    let delay = 0;
    while (Math.abs(clean![RATE + delay]!) < 0.05 && delay < 2000) delay += 1;
    expect(delay).toBeLessThan(200);
  });

  it("copes with silence and clips shorter than one window", () => {
    expect(reduceNoise([new Float32Array(RATE)], 0.5)[0]!.every((sample) => sample === 0)).toBe(true);
    expect(reduceNoise([new Float32Array(100).fill(0.2)], 0.5)[0]!.length).toBe(100);
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

  it("is off unless set, and reaches the plan", () => {
    const { project, segmentId } = clip();
    expect(audioPlan(project, 0)[0]!.denoise).toBe(0);
    const cleaned = updateSegment(project, segmentId, (segment) => {
      segment.denoise = 0.6;
    });
    expect(audioPlan(cleaned, 0)[0]!.denoise).toBe(0.6);
  });

  it("travels with paste attributes", () => {
    const first = clip();
    const second = placeMaterial(first.project, "song", 20_000_000);
    const cleaned = updateSegment(second.project, first.segmentId, (segment) => {
      segment.denoise = 0.6;
    });
    const pasted = pasteAttributes(cleaned, second.segmentId, copySegment(cleaned, first.segmentId)!.segment);
    expect(findSegment(pasted, second.segmentId)!.segment.denoise).toBe(0.6);
  });
});
