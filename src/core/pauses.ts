/** Finds stretches of silence by volume, compared with how loud the clip usually is. */
export const WINDOW_SECONDS = 0.02;
const SILENCE_BELOW_DB = -30;
const LOUD_PERCENTILE = 0.95;
const MIN_REFERENCE_LEVEL = 0.001;
/** Kept on each side of a cut, so a word's start and end are not clipped. */
export const PAUSE_MARGIN_SECONDS = 0.08;

export interface Pause {
  /** Seconds from the start of the audio. */
  start: number;
  end: number;
}

function levels(channels: Float32Array[], sampleRate: number): Float32Array {
  const size = Math.round(sampleRate * WINDOW_SECONDS);
  const length = channels[0]?.length ?? 0;
  const result = new Float32Array(Math.floor(length / size));
  for (let window = 0; window < result.length; window += 1) {
    let sum = 0;
    for (const channel of channels) {
      for (let index = window * size; index < (window + 1) * size; index += 1) sum += channel[index]! ** 2;
    }
    result[window] = Math.sqrt(sum / (size * channels.length));
  }
  return result;
}

/** The stretches between pauses, where someone is talking, within a length in seconds. */
export function soundingRanges(pauses: Pause[], length: number): Pause[] {
  const ranges: Pause[] = [];
  let start = 0;
  for (const pause of pauses) {
    if (pause.start > start) ranges.push({ start, end: pause.start });
    start = pause.end;
  }
  if (start < length) ranges.push({ start, end: length });
  return ranges;
}

/** Silences of at least minSeconds, whole, in seconds from the start of the audio. */
function silencesIn(windows: Float32Array, minSeconds: number): Pause[] {
  if (windows.length === 0) return [];
  const sorted = [...windows].sort((a, b) => a - b);
  const reference = sorted[Math.floor((sorted.length - 1) * LOUD_PERCENTILE)]!;
  if (reference < MIN_REFERENCE_LEVEL) return [];
  const threshold = reference * 10 ** (SILENCE_BELOW_DB / 20);

  const pauses: Pause[] = [];
  let start = -1;
  for (let window = 0; window <= windows.length; window += 1) {
    const quiet = window < windows.length && windows[window]! < threshold;
    if (quiet && start < 0) start = window;
    if (quiet || start < 0) continue;
    const from = start * WINDOW_SECONDS;
    const to = window * WINDOW_SECONDS;
    start = -1;
    if (to - from >= minSeconds) pauses.push({ start: from, end: to });
  }
  return pauses;
}

/** Silences as measured, for keeping as analysis. */
export function detectSilences(channels: Float32Array[], sampleRate: number, minSeconds: number): Pause[] {
  return silencesIn(levels(channels, sampleRate), minSeconds);
}

/** Silences of at least minSeconds, already shortened by the margin. */
export function detectPauses(channels: Float32Array[], sampleRate: number, minSeconds: number): Pause[] {
  const windows = levels(channels, sampleRate);
  const length = windows.length * WINDOW_SECONDS;
  return silencesIn(windows, minSeconds)
    .map(({ start, end }) => ({
      // The edges of the audio have no word to protect.
      start: start === 0 ? 0 : start + PAUSE_MARGIN_SECONDS,
      end: end === length ? end : end - PAUSE_MARGIN_SECONDS,
    }))
    .filter(({ start, end }) => end > start);
}
