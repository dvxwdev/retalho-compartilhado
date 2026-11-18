import { describe, expect, it } from "vitest";
import { GifWriter, quantize } from "../src/core/gif";

function flat(width: number, height: number, red: number, green: number, blue: number): Uint8ClampedArray {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < pixels.length; index += 4) pixels.set([red, green, blue, 255], index);
  return pixels;
}

/** A plain LZW reader, to prove the writer's output decodes back to the same pixels. */
function decodeFirstFrame(bytes: Uint8Array): number[] {
  let at = 13 + 768 + 19 + 8;
  at += 10;
  const minimum = bytes[at++]!;
  const data: number[] = [];
  while (bytes[at]! > 0) {
    const size = bytes[at++]!;
    for (let index = 0; index < size; index += 1) data.push(bytes[at++]!);
  }
  const clear = 1 << minimum;
  const end = clear + 1;
  let table: number[][] = [];
  const reset = () => {
    table = Array.from({ length: clear + 2 }, (_, index) => (index < clear ? [index] : []));
  };
  reset();
  let codeSize = minimum + 1;
  let bits = 0;
  let count = 0;
  let cursor = 0;
  let previous: number[] | null = null;
  const output: number[] = [];
  for (;;) {
    while (count < codeSize) {
      bits |= (data[cursor++] ?? 0) << count;
      count += 8;
    }
    const code = bits & ((1 << codeSize) - 1);
    bits >>>= codeSize;
    count -= codeSize;
    if (code === end) return output;
    if (code === clear) {
      reset();
      codeSize = minimum + 1;
      previous = null;
      continue;
    }
    const entry: number[] = table[code] ?? [...previous!, previous![0]!];
    output.push(...entry);
    if (previous && table.length < 4096) table.push([...previous, entry[0]!]);
    if (table.length === 1 << codeSize && codeSize < 12) codeSize += 1;
    previous = entry;
  }
}

async function bytesOf(writer: GifWriter): Promise<Uint8Array> {
  return new Uint8Array(await writer.finish().arrayBuffer());
}

describe("gif", () => {
  it("writes a valid header and ending", async () => {
    const writer = new GifWriter(4, 2, 7);
    writer.addFrame(flat(4, 2, 255, 0, 0));
    const bytes = await bytesOf(writer);
    expect(new TextDecoder().decode(bytes.subarray(0, 6))).toBe("GIF89a");
    expect(bytes[6]).toBe(4);
    expect(bytes[8]).toBe(2);
    expect(bytes.at(-1)).toBe(0x3b);
  });

  it("maps pure colours to themselves", () => {
    const red = quantize(flat(1, 1, 255, 0, 0), 1, 1)[0]!;
    const black = quantize(flat(1, 1, 0, 0, 0), 1, 1)[0]!;
    const white = quantize(flat(1, 1, 255, 255, 255), 1, 1)[0]!;
    expect(new Set([red, black, white]).size).toBe(3);
    expect(black).toBe(0);
    expect(white).toBe(251);
  });

  it("decodes back to exactly the pixels written", async () => {
    const width = 64;
    const height = 48;
    const pixels = new Uint8ClampedArray(width * height * 4);
    for (let index = 0; index < width * height; index += 1) {
      pixels.set([(index * 7) % 256, (index * 13) % 256, (index * 29) % 256, 255], index * 4);
    }
    const writer = new GifWriter(width, height, 7);
    writer.addFrame(pixels);
    const decoded = decodeFirstFrame(await bytesOf(writer));
    expect(decoded).toEqual([...quantize(pixels, width, height)]);
  });

  it("survives more pixels than the code table can hold", async () => {
    const width = 200;
    const height = 200;
    const pixels = new Uint8ClampedArray(width * height * 4);
    let seed = 5;
    for (let index = 0; index < pixels.length; index += 4) {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      pixels.set([seed & 255, (seed >> 8) & 255, (seed >> 16) & 255, 255], index);
    }
    const writer = new GifWriter(width, height, 7);
    writer.addFrame(pixels);
    expect(decodeFirstFrame(await bytesOf(writer))).toEqual([...quantize(pixels, width, height)]);
  });
});
