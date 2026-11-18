import type { Project } from "./model";

/**
 * A .retalho file holds a project and its media in one file: an 8-byte magic, a
 * little-endian 32-bit header length, a JSON header, then the media bytes in
 * header order. Media stays as Blob parts, so large files are never copied into
 * memory at once.
 */
const MAGIC = "RETALHO1";
const PREFIX_BYTES = MAGIC.length + 4;

export interface StoredMedia {
  id: string;
  blob: Blob;
}

interface Header {
  project: Project;
  media: { id: string; size: number; type: string }[];
}

export function packProject(project: Project, media: StoredMedia[]): Blob {
  const header: Header = {
    project,
    media: media.map(({ id, blob }) => ({ id, size: blob.size, type: blob.type })),
  };
  const json = new TextEncoder().encode(JSON.stringify(header));
  const prefix = new Uint8Array(PREFIX_BYTES);
  prefix.set(new TextEncoder().encode(MAGIC));
  new DataView(prefix.buffer).setUint32(MAGIC.length, json.length, true);
  return new Blob([prefix, json, ...media.map(({ blob }) => blob)], {
    type: "application/octet-stream",
  });
}

function isProject(value: Partial<Project> | undefined): value is Project {
  return value?.format === "retalho" && value.version === 1 && Array.isArray(value.tracks);
}

/** Reads and validates the whole structure, so a bad file fails before anything is replaced. */
export async function unpackProject(file: Blob): Promise<{ project: Project; media: StoredMedia[] }> {
  const invalid = new Error("Este arquivo não é um projeto do Retalho ou está corrompido.");
  if (file.size < PREFIX_BYTES) throw invalid;
  const prefix = new Uint8Array(await file.slice(0, PREFIX_BYTES).arrayBuffer());
  if (new TextDecoder().decode(prefix.subarray(0, MAGIC.length)) !== MAGIC) throw invalid;
  const headerBytes = new DataView(prefix.buffer).getUint32(MAGIC.length, true);
  if (PREFIX_BYTES + headerBytes > file.size) throw invalid;

  let header: Header;
  try {
    const json = await file.slice(PREFIX_BYTES, PREFIX_BYTES + headerBytes).text();
    header = JSON.parse(json) as Header;
  } catch {
    throw invalid;
  }
  if (!isProject(header.project) || !Array.isArray(header.media)) throw invalid;

  let offset = PREFIX_BYTES + headerBytes;
  const media = header.media.map(({ id, size, type }) => {
    const blob = file.slice(offset, offset + size, type);
    offset += size;
    return { id, blob };
  });
  if (offset !== file.size) throw invalid;
  return { project: header.project, media };
}
