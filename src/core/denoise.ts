import { fft } from "./fft";

/**
 * Reduces steady background noise, like hiss, hum or a fan, by spectral
 * subtraction. The noise is learned from the quietest moments of the clip, so a
 * clip with no pauses gives it less to learn from.
 */
const SIZE = 2048;
const HOP = SIZE / 4;
const QUIET_SHARE = 0.1;
/** Removes a little more than was measured, because noise varies around its average. */
const OVER_SUBTRACTION = 2.5;
const SMOOTHING = 0.6;
/** The deepest cut at full strength, in decibels, since that is how loudness is heard. */
const MAX_REDUCTION_DB = 24;

function hann(): Float64Array {
  const window = new Float64Array(SIZE);
  for (let index = 0; index < SIZE; index += 1) {
    window[index] = 0.5 - 0.5 * Math.cos((2 * Math.PI * index) / SIZE);
  }
  return window;
}

/** Starts of the frames with the least energy, leaving out digital silence. */
function quietFrames(samples: Float32Array): number[] {
  const frames: { start: number; energy: number }[] = [];
  for (let start = 0; start + SIZE <= samples.length; start += HOP) {
    let energy = 0;
    for (let index = 0; index < SIZE; index += 8) energy += samples[start + index]! ** 2;
    if (energy > 0) frames.push({ start, energy });
  }
  frames.sort((a, b) => a.energy - b.energy);
  return frames.slice(0, Math.max(1, Math.ceil(frames.length * QUIET_SHARE))).map(({ start }) => start);
}

function noiseProfile(samples: Float32Array, window: Float64Array): Float64Array | null {
  const starts = quietFrames(samples);
  if (starts.length === 0 || samples.length < SIZE) return null;
  const profile = new Float64Array(SIZE / 2 + 1);
  const real = new Float64Array(SIZE);
  const imaginary = new Float64Array(SIZE);
  for (const start of starts) {
    for (let index = 0; index < SIZE; index += 1) real[index] = samples[start + index]! * window[index]!;
    imaginary.fill(0);
    fft(real, imaginary);
    for (let bin = 0; bin < profile.length; bin += 1) profile[bin]! += Math.hypot(real[bin]!, imaginary[bin]!);
  }
  return profile.map((value) => value / starts.length);
}

function cleanChannel(samples: Float32Array, strength: number): Float32Array {
  const window = hann();
  const profile = noiseProfile(samples, window);
  if (!profile) return samples;
  const floor = 10 ** ((-MAX_REDUCTION_DB * strength) / 20);
  const output = new Float64Array(samples.length + SIZE * 2);
  const weight = new Float64Array(samples.length + SIZE * 2);
  const real = new Float64Array(SIZE);
  const imaginary = new Float64Array(SIZE);
  const gains = new Float64Array(profile.length).fill(1);

  // Starting a frame early gives the first samples the same overlap as the rest.
  for (let start = -SIZE + HOP; start < samples.length; start += HOP) {
    for (let index = 0; index < SIZE; index += 1) {
      real[index] = (samples[start + index] ?? 0) * window[index]!;
    }
    imaginary.fill(0);
    fft(real, imaginary);
    for (let bin = 0; bin < profile.length; bin += 1) {
      const magnitude = Math.hypot(real[bin]!, imaginary[bin]!);
      const wanted = magnitude > 0 ? 1 - (strength * OVER_SUBTRACTION * profile[bin]!) / magnitude : floor;
      gains[bin] = SMOOTHING * gains[bin]! + (1 - SMOOTHING) * Math.max(floor, wanted);
      const gain = gains[bin]!;
      real[bin]! *= gain;
      imaginary[bin]! *= gain;
      if (bin > 0 && bin < SIZE / 2) {
        real[SIZE - bin]! *= gain;
        imaginary[SIZE - bin]! *= gain;
      }
    }
    fft(real, imaginary, true);
    for (let index = 0; index < SIZE; index += 1) {
      const position = start + index + SIZE;
      output[position]! += real[index]! * window[index]!;
      weight[position]! += window[index]! ** 2;
    }
  }

  const cleaned = new Float32Array(samples.length);
  for (let index = 0; index < samples.length; index += 1) {
    const position = index + SIZE;
    cleaned[index] = weight[position]! > 1e-6 ? output[position]! / weight[position]! : 0;
  }
  return cleaned;
}

/** Strength from 0, untouched, to 1, the most reduction. */
export function reduceNoise(channels: Float32Array[], strength: number): Float32Array[] {
  return channels.map((channel) => cleanChannel(channel, strength));
}
