import { describe, expect, it } from "vitest";
import { MAX_VOLUME, TARGET_LOUDNESS, measureLoudness, normalizedVolume } from "../src/core/loudness";

const RATE = 48000;

function sine(seconds: number, amplitude: number, frequency = 997): Float32Array {
  const samples = new Float32Array(seconds * RATE);
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = amplitude * Math.sin((2 * Math.PI * frequency * index) / RATE);
  }
  return samples;
}

describe("loudness", () => {
  it("matches the reference level of the standard", () => {
    // BS.1770 defines a full-scale 997 Hz tone in one of two channels as -3.01 LKFS.
    const left = sine(3, 1);
    const silent = new Float32Array(left.length);
    expect(measureLoudness([left, silent]).loudness).toBeCloseTo(-3.01, 1);
  });

  it("drops by 20 dB when the amplitude falls to a tenth", () => {
    const loud = measureLoudness([sine(3, 0.5), sine(3, 0.5)]).loudness;
    const quiet = measureLoudness([sine(3, 0.05), sine(3, 0.05)]).loudness;
    expect(loud - quiet).toBeCloseTo(20, 1);
  });

  it("counts a mono clip as playing on both speakers", () => {
    const mono = measureLoudness([sine(3, 0.5)]).loudness;
    const stereo = measureLoudness([sine(3, 0.5), sine(3, 0.5)]).loudness;
    expect(mono).toBeCloseTo(stereo, 3);
  });

  it("ignores long pauses, as the gate intends", () => {
    const tone = sine(2, 0.5);
    const paused = new Float32Array(tone.length * 4);
    paused.set(tone);
    const alone = measureLoudness([tone]).loudness;
    expect(measureLoudness([paused]).loudness).toBeCloseTo(alone, 0);
  });

  it("weighs low rumble less than the middle of the spectrum", () => {
    const rumble = measureLoudness([sine(3, 0.5, 40)]).loudness;
    const voice = measureLoudness([sine(3, 0.5, 1000)]).loudness;
    expect(rumble).toBeLessThan(voice - 3);
  });

  it("reports silence and very short clips without failing", () => {
    expect(measureLoudness([new Float32Array(RATE)]).loudness).toBe(-Infinity);
    expect(measureLoudness([new Float32Array(0)]).loudness).toBe(-Infinity);
    expect(Number.isFinite(measureLoudness([sine(0.1, 0.5)]).loudness)).toBe(true);
  });
});

describe("normalized volume", () => {
  it("reaches the target", () => {
    const quiet = sine(3, 0.02);
    const report = measureLoudness([quiet]);
    const volume = normalizedVolume({ ...report, peak: 0.02 })!;
    const scaled = quiet.map((sample) => sample * Math.min(volume, MAX_VOLUME));
    expect(volume).toBeLessThanOrEqual(MAX_VOLUME);
    expect(measureLoudness([scaled]).loudness).toBeLessThanOrEqual(TARGET_LOUDNESS + 0.1);
  });

  it("turns down a clip that is too loud", () => {
    const report = measureLoudness([sine(3, 0.9), sine(3, 0.9)]);
    const volume = normalizedVolume(report)!;
    expect(volume).toBeLessThan(1);
    const scaled = sine(3, 0.9 * volume);
    expect(measureLoudness([scaled, scaled]).loudness).toBeCloseTo(TARGET_LOUDNESS, 1);
  });

  it("never lets a peak clip", () => {
    expect(normalizedVolume({ loudness: -30, peak: 0.8 })).toBeCloseTo(1.25);
  });

  it("leaves silence alone", () => {
    expect(normalizedVolume({ loudness: -Infinity, peak: 0 })).toBeNull();
  });
});
