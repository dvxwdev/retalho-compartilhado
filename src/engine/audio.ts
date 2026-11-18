import { SECOND, type AudioEffects, type Project, type Us } from "../core/model";
import { audioPlan, type AudioEvent } from "../core/resolve";
import { processedAudio } from "./audioJobs";
import { pool } from "./media";

const LOW_SHELF_HZ = 200;
const MID_BAND_HZ = 1000;
const HIGH_SHELF_HZ = 4000;
const REVERB_SECONDS = 2;

const impulses = new Map<number, AudioBuffer>();

/** A decaying burst of noise, which is what a room does to a single clap. */
function roomImpulse(sampleRate: number): AudioBuffer {
  let impulse = impulses.get(sampleRate);
  if (!impulse) {
    const length = Math.round(sampleRate * REVERB_SECONDS);
    impulse = new AudioBuffer({ length, numberOfChannels: 2, sampleRate });
    let seed = 1;
    for (let channel = 0; channel < 2; channel += 1) {
      const samples = impulse.getChannelData(channel);
      for (let index = 0; index < length; index += 1) {
        seed = (seed * 1664525 + 1013904223) % 4294967296;
        samples[index] = (seed / 2147483648 - 1) * (1 - index / length) ** 3;
      }
    }
    impulses.set(sampleRate, impulse);
  }
  return impulse;
}

/** Runs a signal through a clip's effects and gives back what comes out. */
function connectEffects(context: BaseAudioContext, input: AudioNode, effects: AudioEffects): AudioNode {
  let node = input;
  const band = (type: BiquadFilterType, frequency: number, gain: number) => {
    if (!gain) return;
    const filter = context.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = frequency;
    filter.gain.value = gain;
    node.connect(filter);
    node = filter;
  };
  band("lowshelf", LOW_SHELF_HZ, effects.low);
  band("peaking", MID_BAND_HZ, effects.mid);
  band("highshelf", HIGH_SHELF_HZ, effects.high);
  if (effects.compressor) {
    const compressor = context.createDynamicsCompressor();
    compressor.threshold.value = -24;
    compressor.ratio.value = 4;
    node.connect(compressor);
    node = compressor;
  }
  if (effects.reverb > 0) {
    const room = context.createConvolver();
    room.buffer = roomImpulse(context.sampleRate);
    const wet = context.createGain();
    wet.gain.value = effects.reverb;
    const mix = context.createGain();
    node.connect(room).connect(wet).connect(mix);
    node.connect(mix);
    node = mix;
  }
  return node;
}

const DIP_ATTACK: Us = 200_000;
const DIP_RELEASE: Us = 400_000;

/**
 * Schedules a plan on any audio context. Timeline time `from` maps to context
 * time `origin`, which lets live playback and offline export share this code.
 * `parts` holds what was read for clips kept on disk, and `until` is where those
 * parts end, in context time.
 */
export function scheduleAudio(
  context: BaseAudioContext,
  destination: AudioNode,
  events: AudioEvent[],
  from: Us,
  origin: number,
  parts?: Map<AudioEvent, AudioBuffer>,
  until = Infinity,
): AudioBufferSourceNode[] {
  const sources: AudioBufferSourceNode[] = [];
  for (const event of events) {
    const original = pool.audioBuffer(event.materialId);
    const part = parts?.get(event);
    const ready = processedAudio(event);
    if (!original && !part && !ready) continue;
    const when = origin + (event.at - from) / SECOND;
    const length = event.duration / SECOND;
    const end = when + length;

    const gain = context.createGain();
    const value = gain.gain;
    if (event.skipped < event.fadeIn) {
      value.setValueAtTime((event.gain * event.skipped) / event.fadeIn, when);
      value.linearRampToValueAtTime(event.gain, when + (event.fadeIn - event.skipped) / SECOND);
    } else {
      value.setValueAtTime(event.gain, when);
    }
    if (event.fadeOut > 0) {
      const fadeStart = Math.max(when, end - event.fadeOut / SECOND);
      const remaining = Math.min(1, event.duration / event.fadeOut);
      value.setValueAtTime(event.gain * remaining, fadeStart);
      value.linearRampToValueAtTime(0, end);
    }

    const dip = event.dips.length ? context.createGain() : null;
    if (dip) applyDips(dip.gain, event, from, origin);

    const source = context.createBufferSource();
    source.buffer = ready?.buffer ?? part ?? original!;
    source.playbackRate.value = ready?.rate ?? event.rate;
    const shaped = dip ? source.connect(dip) : source;
    (event.effects ? connectEffects(context, shaped, event.effects) : shaped).connect(gain);
    if (event.pan) {
      const panner = context.createStereoPanner();
      panner.pan.value = event.pan;
      gain.connect(panner).connect(destination);
    } else {
      gain.connect(destination);
    }
    const start = Math.max(when, 0);
    if (ready) {
      // A prepared clip holds only that clip, so it is read from its own start.
      source.start(start, (event.skipped / SECOND) * ready.rate, length * ready.rate);
    } else if (part) {
      // A late part skips what should already have played, to stay in sync with the picture.
      const late = Math.max(0, context.currentTime - when);
      const playing = Math.min(end, until) - when;
      if (playing > late) source.start(Math.max(start, context.currentTime), late * event.rate, (playing - late) * event.rate);
    } else {
      source.start(start, event.offset / SECOND, length * event.rate);
    }
    sources.push(source);
  }
  return sources;
}

/** Lowers the sound during each dip, easing in and out so it does not jump. */
function applyDips(gain: AudioParam, event: AudioEvent, from: Us, origin: number): void {
  const low = 1 - event.dipAmount;
  const at = (time: Us) => Math.max(0, origin + (time - from) / SECOND);
  gain.setValueAtTime(1, 0);
  for (const { start, end } of event.dips) {
    gain.setValueAtTime(1, at(start - DIP_ATTACK));
    gain.linearRampToValueAtTime(low, at(start));
    gain.setValueAtTime(low, at(end));
    gain.linearRampToValueAtTime(1, at(end + DIP_RELEASE));
  }
}

/** Clips whose sound stays on disk and has not been prepared as a whole. */
export function readsInParts(event: AudioEvent): boolean {
  return pool.isStreamed(event.materialId) && !processedAudio(event);
}

/** Reads and schedules a stretch of the sound that stays on disk. */
export async function scheduleParts(
  context: BaseAudioContext,
  destination: AudioNode,
  project: Project,
  from: Us,
  origin: number,
  seconds: number,
): Promise<AudioBufferSourceNode[]> {
  const end = from + seconds * SECOND;
  const events = audioPlan(project, from).filter((event) => event.at < end && readsInParts(event));
  const parts = new Map<AudioEvent, AudioBuffer>();
  await Promise.all(
    events.map(async (event) => {
      const duration = Math.min(event.duration, end - event.at);
      const part = await pool.readAudio(event.materialId, {
        start: event.offset,
        duration: Math.round(duration * event.rate),
      });
      if (part) parts.set(event, part);
    }),
  );
  return scheduleAudio(context, destination, events, from, origin, parts, origin + seconds);
}
