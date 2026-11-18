const HEADER_BYTES = 44;
const BYTES_PER_SAMPLE = 2;

/** The start of a file holding this many frames, for when the samples arrive in parts. */
export function wavHeader(frames: number, count: number, sampleRate: number): ArrayBuffer {
  const dataBytes = frames * count * BYTES_PER_SAMPLE;
  const buffer = new ArrayBuffer(HEADER_BYTES);
  const view = new DataView(buffer);
  const writeTag = (offset: number, tag: string) => {
    for (let index = 0; index < tag.length; index += 1) view.setUint8(offset + index, tag.charCodeAt(index));
  };

  writeTag(0, "RIFF");
  view.setUint32(4, HEADER_BYTES - 8 + dataBytes, true);
  writeTag(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, count, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * count * BYTES_PER_SAMPLE, true);
  view.setUint16(32, count * BYTES_PER_SAMPLE, true);
  view.setUint16(34, BYTES_PER_SAMPLE * 8, true);
  writeTag(36, "data");
  view.setUint32(40, dataBytes, true);
  return buffer;
}

/** Equal-length channels as 16-bit PCM. Samples past full scale are clipped. */
export function wavSamples(channels: Float32Array[]): ArrayBuffer {
  const frames = channels[0]?.length ?? 0;
  const buffer = new ArrayBuffer(frames * channels.length * BYTES_PER_SAMPLE);
  const view = new DataView(buffer);
  let offset = 0;
  for (let frame = 0; frame < frames; frame += 1) {
    for (const channel of channels) {
      const sample = Math.max(-1, Math.min(1, channel[frame]!));
      view.setInt16(offset, Math.round(sample * 32767), true);
      offset += BYTES_PER_SAMPLE;
    }
  }
  return buffer;
}

export function encodeWav(channels: Float32Array[], sampleRate: number): ArrayBuffer {
  const header = new Uint8Array(wavHeader(channels[0]?.length ?? 0, channels.length, sampleRate));
  const samples = new Uint8Array(wavSamples(channels));
  const whole = new Uint8Array(header.length + samples.length);
  whole.set(header);
  whole.set(samples, header.length);
  return whole.buffer;
}
