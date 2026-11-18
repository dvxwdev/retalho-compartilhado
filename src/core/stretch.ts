/**
 * Changes the length of audio without changing its pitch, using WSOLA: the output
 * is built from overlapping windows, and each window is taken from wherever near
 * its ideal position it lines up best with what came before, so waves stay in
 * phase across the joins.
 */
const WINDOW = 1536;
const HOP = WINDOW / 2;
const SEARCH = 512;
const SEARCH_STEP = 2;
const COMPARE_STRIDE = 4;

function hann(size: number): Float32Array {
  const window = new Float32Array(size);
  for (let index = 0; index < size; index += 1) {
    window[index] = 0.5 - 0.5 * Math.cos((2 * Math.PI * index) / size);
  }
  return window;
}

/** Where a window lines up best with the audio that naturally follows the last one. */
function bestStart(guide: Float32Array, ideal: number, natural: number, limit: number): number {
  let best = Math.min(Math.max(ideal, 0), limit);
  let bestScore = -Infinity;
  for (let delta = -SEARCH; delta <= SEARCH; delta += SEARCH_STEP) {
    const candidate = ideal + delta;
    if (candidate < 0 || candidate > limit) continue;
    let score = 0;
    for (let index = 0; index < HOP && natural + index < guide.length; index += COMPARE_STRIDE) {
      score += guide[candidate + index]! * guide[natural + index]!;
    }
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return best;
}

/** Plays back at a rate, so 2 halves the length, and returns exactly outputLength samples. */
export function timeStretch(channels: Float32Array[], rate: number, outputLength: number): Float32Array[] {
  const guide = channels[0];
  const output = channels.map(() => new Float32Array(outputLength + WINDOW));
  if (!guide || guide.length < WINDOW) {
    return channels.map((channel) => {
      const short = new Float32Array(outputLength);
      short.set(channel.subarray(0, outputLength));
      return short;
    });
  }

  const window = hann(WINDOW);
  const weight = new Float32Array(outputLength + WINDOW);
  const limit = guide.length - WINDOW;
  let previous = 0;
  for (let position = 0; position < outputLength; position += HOP) {
    const ideal = Math.round(position * rate);
    const start = position === 0 ? 0 : bestStart(guide, ideal, previous + HOP, limit);
    for (let channel = 0; channel < channels.length; channel += 1) {
      const source = channels[channel]!;
      const target = output[channel]!;
      for (let index = 0; index < WINDOW; index += 1) {
        target[position + index]! += source[start + index]! * window[index]!;
      }
    }
    for (let index = 0; index < WINDOW; index += 1) weight[position + index]! += window[index]!;
    previous = start;
  }

  return output.map((channel) => {
    const result = new Float32Array(outputLength);
    for (let index = 0; index < outputLength; index += 1) {
      // The very first samples have almost no window over them; dividing there would amplify noise.
      result[index] = weight[index]! > 0.01 ? channel[index]! / weight[index]! : 0;
    }
    return result;
  });
}
