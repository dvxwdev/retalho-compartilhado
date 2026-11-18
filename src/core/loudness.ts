/**
 * Programme loudness as defined by ITU-R BS.1770: K-weighted, measured in
 * overlapping blocks and gated, so silence and pauses do not lower the result.
 * The filter coefficients are the ones the standard gives for 48 kHz, the rate
 * all media is decoded to.
 */
const SHELF = { b: [1.53512485958697, -2.69169618940638, 1.19839281085285], a: [-1.69065929318241, 0.73248077421585] };
const HIGH_PASS = { b: [1, -2, 1], a: [-1.99004745483398, 0.99007225036621] };

const SAMPLE_RATE = 48000;
const BLOCK_SAMPLES = SAMPLE_RATE * 0.4;
const BLOCK_STEP = BLOCK_SAMPLES / 4;
const ABSOLUTE_GATE = -70;
const RELATIVE_GATE = -10;
const LOUDNESS_OFFSET = -0.691;

export const TARGET_LOUDNESS = -14;
export const MAX_VOLUME = 4;

export interface LoudnessReport {
  /** LUFS, or -Infinity for silence. */
  loudness: number;
  /** Highest absolute sample. */
  peak: number;
}

function biquad(input: Float32Array, { b, a }: typeof SHELF): Float32Array {
  const output = new Float32Array(input.length);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let index = 0; index < input.length; index += 1) {
    const x = input[index]!;
    const y = b[0]! * x + b[1]! * x1 + b[2]! * x2 - a[0]! * y1 - a[1]! * y2;
    output[index] = y;
    x2 = x1;
    x1 = x;
    y2 = y1;
    y1 = y;
  }
  return output;
}

const blockLoudness = (meanSquare: number) => LOUDNESS_OFFSET + 10 * Math.log10(meanSquare);

/** A mono clip plays on both speakers, so it counts as two equal channels. */
export function measureLoudness(channels: Float32Array[]): LoudnessReport {
  let peak = 0;
  for (const channel of channels) {
    for (let index = 0; index < channel.length; index += 1) peak = Math.max(peak, Math.abs(channel[index]!));
  }
  const weighted = channels.map((channel) => biquad(biquad(channel, SHELF), HIGH_PASS));
  const pairs = weighted.length === 1 ? [weighted[0]!, weighted[0]!] : weighted;
  const length = weighted[0]?.length ?? 0;

  // Prefix sums make each of the many overlapping blocks a single subtraction.
  const energy = new Float64Array(length + 1);
  for (let index = 0; index < length; index += 1) {
    let sum = 0;
    for (const channel of pairs) sum += channel[index]! ** 2;
    energy[index + 1] = energy[index]! + sum;
  }

  const blocks: number[] = [];
  const size = Math.min(BLOCK_SAMPLES, length);
  for (let start = 0; size > 0 && start + size <= length; start += BLOCK_STEP) {
    blocks.push((energy[start + size]! - energy[start]!) / size);
  }

  const audible = blocks.filter((block) => block > 0 && blockLoudness(block) > ABSOLUTE_GATE);
  if (audible.length === 0) return { loudness: -Infinity, peak };
  const mean = (values: number[]) => values.reduce((total, value) => total + value, 0) / values.length;
  const gate = blockLoudness(mean(audible)) + RELATIVE_GATE;
  const kept = audible.filter((block) => blockLoudness(block) > gate);
  return { loudness: blockLoudness(mean(kept)), peak };
}

/** The volume that reaches the target, held back so the peak never clips. Null for silence. */
export function normalizedVolume({ loudness, peak }: LoudnessReport): number | null {
  if (!Number.isFinite(loudness) || peak <= 0) return null;
  const wanted = 10 ** ((TARGET_LOUDNESS - loudness) / 20);
  return Math.min(wanted, 1 / peak, MAX_VOLUME);
}
