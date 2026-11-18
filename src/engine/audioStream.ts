import { ALL_FORMATS, AudioBufferSink, BlobSource, Input } from "mediabunny";

const OUTPUT_RATE = 48000;

/** Decodes parts of a file on demand, so its length never decides how much memory it takes. */
export class AudioStream {
  private constructor(
    private sink: AudioBufferSink,
    readonly duration: number,
    readonly channels: number,
  ) {}

  /** Null when the file has no sound this reader can decode. */
  static async open(blob: Blob): Promise<AudioStream | null> {
    const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
    const track = await input.getPrimaryAudioTrack();
    if (!track || !(await track.canDecode())) return null;
    const duration = await input.computeDuration([track]);
    return new AudioStream(new AudioBufferSink(track), duration, track.numberOfChannels);
  }

  /** Every decoded piece of a stretch, in order. */
  pieces(start = 0, end = this.duration) {
    return this.sink.buffers(start, end);
  }

  /** Exactly one stretch of sound, at the rate the rest of the editor uses. */
  async read(start: number, seconds: number): Promise<AudioBuffer | null> {
    let rate = 0;
    let output: Float32Array[] = [];
    for await (const { buffer, timestamp } of this.sink.buffers(start, start + seconds)) {
      if (!rate) {
        rate = buffer.sampleRate;
        const length = Math.max(1, Math.round(seconds * rate));
        output = Array.from({ length: buffer.numberOfChannels }, () => new Float32Array(length));
      }
      const offset = Math.round((timestamp - start) * rate);
      output.forEach((channel, index) => {
        const samples = buffer.getChannelData(Math.min(index, buffer.numberOfChannels - 1));
        // A piece can begin before the stretch or run past it; only the overlap is copied.
        const from = Math.max(0, -offset);
        const to = Math.min(samples.length, channel.length - offset);
        if (to > from) channel.set(samples.subarray(from, to), offset + from);
      });
    }
    if (!rate) return null;
    const result = new AudioBuffer({ length: output[0]!.length, numberOfChannels: output.length, sampleRate: rate });
    output.forEach((channel, index) => result.copyToChannel(channel as Float32Array<ArrayBuffer>, index));
    return rate === OUTPUT_RATE ? result : resample(result);
  }
}

async function resample(buffer: AudioBuffer): Promise<AudioBuffer> {
  const length = Math.max(1, Math.round(buffer.duration * OUTPUT_RATE));
  const context = new OfflineAudioContext(buffer.numberOfChannels, length, OUTPUT_RATE);
  const source = context.createBufferSource();
  source.buffer = buffer;
  source.connect(context.destination);
  source.start();
  return context.startRendering();
}
