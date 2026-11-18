import {
  ALL_FORMATS,
  BlobSource,
  Conversion,
  Input,
  Mp4OutputFormat,
  Output,
  QUALITY_MEDIUM,
  StreamTarget,
} from "mediabunny";

/** Height of the light copy used for editing. Exports always read the original. */
export const PROXY_HEIGHT = 540;

const fileName = (id: string) => `proxy-${id}.mp4`;

/** A copy made earlier. An interrupted one is never saved, so what exists is complete. */
export async function loadProxy(id: string): Promise<File | null> {
  const folder = await navigator.storage.getDirectory();
  const handle = await folder.getFileHandle(fileName(id)).catch(() => null);
  const file = await handle?.getFile();
  return file?.size ? file : null;
}

export async function makeProxy(id: string, blob: Blob, onProgress: (fraction: number) => void): Promise<File> {
  const folder = await navigator.storage.getDirectory();
  const handle = await folder.getFileHandle(fileName(id), { create: true });
  const writable = await handle.createWritable();
  try {
    const conversion = await Conversion.init({
      input: new Input({ source: new BlobSource(blob), formats: ALL_FORMATS }),
      output: new Output({ format: new Mp4OutputFormat(), target: new StreamTarget(writable) }),
      video: { height: PROXY_HEIGHT, bitrate: QUALITY_MEDIUM },
      audio: { discard: true },
    });
    if (!conversion.isValid) throw new Error("Não foi possível converter este vídeo.");
    conversion.onProgress = onProgress;
    await conversion.execute();
  } catch (error) {
    await writable.abort().catch(() => undefined);
    await folder.removeEntry(fileName(id)).catch(() => undefined);
    throw error;
  }
  return handle.getFile();
}

/** Frees the disk space taken by every copy. */
export async function removeProxies(): Promise<void> {
  const folder = await navigator.storage.getDirectory();
  for await (const name of (folder as unknown as { keys(): AsyncIterable<string> }).keys()) {
    if (name.startsWith("proxy-")) await folder.removeEntry(name).catch(() => undefined);
  }
}
