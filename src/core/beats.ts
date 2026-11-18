/**
 * Finds the beat of a recording: an onset curve from jumps in energy, the tempo
 * from how that curve repeats, then beats followed one by one, so a tempo that
 * drifts a little is tracked instead of slowly going out of step.
 */
const FRAME = 1024;
const HOP = 512;
const MIN_BPM = 60;
const MAX_BPM = 180;
/** Musicians count around here, which settles whether a pulse is 60 or 120. */
const PREFERRED_BPM = 120;
const PREFERENCE_WIDTH = 1.2;
/** How far the best repeat must stand above the average one to count as rhythm, not noise. */
const MIN_CONTRAST = 1.5;
/** Below this average jump in energy there are no real attacks to follow. */
const MIN_ONSET_LEVEL = 1e-4;
const MIN_CYCLES = 4;
/** Only the opening sets the phase, because a drifting tempo blurs it over a whole song. */
const PHASE_CYCLES = 8;
/** How much each beat found corrects the tempo, so a slow drift is followed. */
const TEMPO_ADAPTATION = 0.15;
/** How far a beat may land from where the tempo predicts, as a share of the period. */
const TRACKING_TOLERANCE = 0.12;
const LOCAL_AVERAGE_FRAMES = 40;

function onsetCurve(samples: Float32Array): Float32Array {
  const frames = Math.floor((samples.length - FRAME) / HOP);
  if (frames <= 1) return new Float32Array(0);
  const levels = new Float32Array(frames);
  for (let frame = 0; frame < frames; frame += 1) {
    let energy = 0;
    const start = frame * HOP;
    for (let index = 0; index < FRAME; index += 1) energy += samples[start + index]! ** 2;
    levels[frame] = Math.log1p((energy / FRAME) * 1000);
  }
  const curve = new Float32Array(frames);
  for (let frame = 1; frame < frames; frame += 1) curve[frame] = Math.max(0, levels[frame]! - levels[frame - 1]!);

  // Removing the local average keeps a loud passage from drowning out the quiet ones.
  const flattened = new Float32Array(frames);
  let sum = 0;
  for (let frame = 0; frame < frames; frame += 1) {
    sum += curve[frame]!;
    if (frame >= LOCAL_AVERAGE_FRAMES) sum -= curve[frame - LOCAL_AVERAGE_FRAMES]!;
    flattened[frame] = Math.max(0, curve[frame]! - (sum / Math.min(frame + 1, LOCAL_AVERAGE_FRAMES)) * 1.2);
  }
  return flattened;
}

/** Spreads each onset over nearby frames, so a period between two frames is not penalized. */
function smoothed(curve: Float32Array): Float32Array {
  const result = new Float32Array(curve.length);
  for (let frame = 2; frame < curve.length - 2; frame += 1) {
    result[frame] =
      (curve[frame - 2]! + 2 * curve[frame - 1]! + 3 * curve[frame]! + 2 * curve[frame + 1]! + curve[frame + 2]!) / 9;
  }
  return result;
}

function correlation(curve: Float32Array, lag: number): number {
  let sum = 0;
  for (let frame = lag; frame < curve.length; frame += 1) sum += curve[frame]! * curve[frame - lag]!;
  return sum;
}

/** Frames per beat, or null when nothing repeats clearly enough. */
function beatPeriod(onsets: Float32Array, frameRate: number): number | null {
  const shortest = Math.floor((60 / MAX_BPM) * frameRate);
  const longest = Math.ceil((60 / MIN_BPM) * frameRate);
  if (onsets.length < longest * MIN_CYCLES) return null;
  const level = onsets.reduce((total, value) => total + value, 0) / onsets.length;
  if (level < MIN_ONSET_LEVEL) return null;
  const curve = smoothed(onsets);

  let best = 0;
  let bestScore = 0;
  let bestStrength = 0;
  let totalStrength = 0;
  for (let lag = shortest; lag <= longest; lag += 1) {
    // Fewer frames overlap at longer lags, which would otherwise favour short ones.
    const strength = correlation(curve, lag) / (curve.length - lag);
    totalStrength += strength;
    const bpm = (60 * frameRate) / lag;
    const distance = Math.log2(bpm / PREFERRED_BPM) / PREFERENCE_WIDTH;
    const score = strength * Math.exp(-0.5 * distance * distance);
    if (score > bestScore) {
      best = lag;
      bestScore = score;
      bestStrength = strength;
    }
  }
  const average = totalStrength / (longest - shortest + 1);
  if (average <= 0 || bestStrength < average * MIN_CONTRAST) return null;

  // The peak falls between two frames; the neighbours say where.
  const before = correlation(curve, best - 1);
  const center = correlation(curve, best);
  const after = correlation(curve, best + 1);
  const bend = before - 2 * center + after;
  return best + (bend < 0 ? (0.5 * (before - after)) / bend : 0);
}

function strongestPhase(curve: Float32Array, period: number): number {
  const end = Math.min(curve.length, period * PHASE_CYCLES);
  let best = 0;
  let bestScore = -1;
  for (let phase = 0; phase < period; phase += 1) {
    let score = 0;
    for (let frame = phase; frame < end; frame += period) score += curve[Math.round(frame)] ?? 0;
    if (score > bestScore) {
      bestScore = score;
      best = phase;
    }
  }
  return best;
}

/** Beat times in seconds from the start of the audio. Empty when there is no clear pulse. */
export function detectBeats(channels: Float32Array[], sampleRate: number): number[] {
  const first = channels[0];
  if (!first) return [];
  const mixed = new Float32Array(first.length);
  for (const channel of channels) {
    for (let index = 0; index < mixed.length; index += 1) mixed[index]! += channel[index]! / channels.length;
  }

  const curve = onsetCurve(mixed);
  const frameRate = sampleRate / HOP;
  let period = beatPeriod(curve, frameRate);
  if (!period) return [];

  const tolerance = Math.max(2, Math.round(period * TRACKING_TOLERANCE));
  const beats: number[] = [];
  let expected = strongestPhase(smoothed(curve), period);
  while (expected < curve.length) {
    let found = Math.round(expected);
    let strongest = 0;
    // The first beat rests on an estimate, so it gets a wider search than the ones that follow.
    const reach = beats.length === 0 ? Math.round(period / 2) : tolerance;
    for (let frame = found - reach; frame <= found + reach; frame += 1) {
      if ((curve[frame] ?? 0) > strongest) {
        strongest = curve[frame]!;
        found = frame;
      }
    }
    // A sound enters a frame through its end, so that is where its onset really is.
    beats.push((found * HOP + FRAME - HOP / 2) / sampleRate);
    if (strongest > 0) {
      period += (found - expected) * TEMPO_ADAPTATION;
      expected = found;
    }
    expected += period;
  }
  return beats;
}
