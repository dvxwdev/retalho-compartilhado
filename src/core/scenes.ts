/** Picks hard cuts out of how much each sampled frame differs from the one before. */
const MIN_DIFFERENCE = 0.12;
const SPREAD_FACTOR = 4;

/** Average colour difference between two small frames, from 0 to 1. */
export function frameDifference(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
  let sum = 0;
  let count = 0;
  for (let index = 0; index < a.length; index += 4) {
    sum += Math.abs(a[index]! - b[index]!) + Math.abs(a[index + 1]! - b[index + 1]!) + Math.abs(a[index + 2]! - b[index + 2]!);
    count += 3;
  }
  return count ? sum / (count * 255) : 0;
}

/**
 * Indexes where a jump stands out from the clip's usual movement, so a busy clip
 * needs a bigger jump than a still one. A slow fade never makes one sharp jump.
 */
export function pickCuts(differences: number[]): number[] {
  if (differences.length === 0) return [];
  const sorted = [...differences].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)]!;
  // The median deviation stays honest even when many of the jumps are the cuts themselves.
  const deviations = differences.map((value) => Math.abs(value - median)).sort((a, b) => a - b);
  const spread = deviations[Math.floor(deviations.length / 2)]! * 1.5;
  const threshold = Math.max(MIN_DIFFERENCE, median + spread * SPREAD_FACTOR);
  const cuts: number[] = [];
  differences.forEach((difference, index) => {
    if (difference < threshold) return;
    const before = differences[index - 1] ?? 0;
    const after = differences[index + 1] ?? 0;
    if (difference >= before && difference > after) cuts.push(index);
  });
  return cuts;
}
