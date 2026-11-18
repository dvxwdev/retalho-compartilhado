/** A microphone recording in progress. */
export class Narration {
  private chunks: Blob[] = [];

  private constructor(
    private stream: MediaStream,
    private recorder: MediaRecorder,
  ) {
    recorder.ondataavailable = (event) => this.chunks.push(event.data);
  }

  /** Resolves once the recorder is running, so the caller can start the timeline in sync. */
  static async start(): Promise<Narration> {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const recorder = new MediaRecorder(stream);
    const narration = new Narration(stream, recorder);
    await new Promise<void>((resolve) => {
      recorder.onstart = () => resolve();
      recorder.start();
    });
    return narration;
  }

  stop(): Promise<File> {
    return new Promise((resolve) => {
      this.recorder.onstop = () => {
        for (const track of this.stream.getTracks()) track.stop();
        const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
        resolve(new File(this.chunks, `narracao-${stamp}.webm`, { type: this.recorder.mimeType }));
      };
      this.recorder.stop();
    });
  }
}
