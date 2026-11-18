/** A small animated GIF encoder: one fixed 256-colour palette and LZW compression. */
const LEVELS = { red: 6, green: 7, blue: 6 };
const MAX_CODES = 4096;

function paletteBytes(): Uint8Array {
  const table = new Uint8Array(256 * 3);
  let index = 0;
  for (let red = 0; red < LEVELS.red; red += 1) {
    for (let green = 0; green < LEVELS.green; green += 1) {
      for (let blue = 0; blue < LEVELS.blue; blue += 1) {
        table[index++] = Math.round((red * 255) / (LEVELS.red - 1));
        table[index++] = Math.round((green * 255) / (LEVELS.green - 1));
        table[index++] = Math.round((blue * 255) / (LEVELS.blue - 1));
      }
    }
  }
  return table;
}

/** The nearest palette colour for each pixel, with the rounding error passed along a row to avoid banding. */
export function quantize(rgba: Uint8ClampedArray, width: number, height: number): Uint8Array {
  const indexes = new Uint8Array(width * height);
  const step = (levels: number) => 255 / (levels - 1);
  for (let y = 0; y < height; y += 1) {
    let carryRed = 0;
    let carryGreen = 0;
    let carryBlue = 0;
    for (let x = 0; x < width; x += 1) {
      const at = (y * width + x) * 4;
      const red = Math.min(255, Math.max(0, rgba[at]! + carryRed));
      const green = Math.min(255, Math.max(0, rgba[at + 1]! + carryGreen));
      const blue = Math.min(255, Math.max(0, rgba[at + 2]! + carryBlue));
      const levelRed = Math.round(red / step(LEVELS.red));
      const levelGreen = Math.round(green / step(LEVELS.green));
      const levelBlue = Math.round(blue / step(LEVELS.blue));
      carryRed = (red - levelRed * step(LEVELS.red)) / 2;
      carryGreen = (green - levelGreen * step(LEVELS.green)) / 2;
      carryBlue = (blue - levelBlue * step(LEVELS.blue)) / 2;
      indexes[y * width + x] = (levelRed * LEVELS.green + levelGreen) * LEVELS.blue + levelBlue;
    }
  }
  return indexes;
}

/** GIF's LZW, written in sub-blocks of at most 255 bytes. */
function compress(indexes: Uint8Array): Uint8Array {
  const minimumCodeSize = 8;
  const clear = 1 << minimumCodeSize;
  const end = clear + 1;
  const bytes: number[] = [];
  let bits = 0;
  let bitCount = 0;
  let codeSize = minimumCodeSize + 1;
  const write = (code: number) => {
    bits |= code << bitCount;
    bitCount += codeSize;
    while (bitCount >= 8) {
      bytes.push(bits & 255);
      bits >>>= 8;
      bitCount -= 8;
    }
  };

  let dictionary = new Map<number, number>();
  let next = end + 1;
  write(clear);
  let prefix = indexes[0]!;
  for (let index = 1; index < indexes.length; index += 1) {
    const value = indexes[index]!;
    const key = prefix * 256 + value;
    const known = dictionary.get(key);
    if (known !== undefined) {
      prefix = known;
      continue;
    }
    write(prefix);
    if (next < MAX_CODES) {
      if (next === 1 << codeSize && codeSize < 12) codeSize += 1;
      dictionary.set(key, next);
      next += 1;
    } else {
      write(clear);
      dictionary = new Map();
      next = end + 1;
      codeSize = minimumCodeSize + 1;
    }
    prefix = value;
  }
  write(prefix);
  write(end);
  if (bitCount > 0) bytes.push(bits & 255);

  const output = new Uint8Array(1 + bytes.length + Math.ceil(bytes.length / 255) + 1);
  let at = 0;
  output[at++] = minimumCodeSize;
  for (let start = 0; start < bytes.length; start += 255) {
    const size = Math.min(255, bytes.length - start);
    output[at++] = size;
    for (let offset = 0; offset < size; offset += 1) output[at++] = bytes[start + offset]!;
  }
  output[at++] = 0;
  return output.subarray(0, at);
}

export class GifWriter {
  private parts: Uint8Array[] = [];

  constructor(
    private width: number,
    private height: number,
    private delayCentiseconds: number,
  ) {
    const word = (value: number) => [value & 255, value >> 8];
    this.parts.push(
      new Uint8Array([
        ...new TextEncoder().encode("GIF89a"),
        ...word(width),
        ...word(height),
        0xf7,
        0,
        0,
      ]),
      paletteBytes(),
      // Tells players to loop forever.
      new Uint8Array([0x21, 0xff, 11, ...new TextEncoder().encode("NETSCAPE2.0"), 3, 1, 0, 0, 0]),
    );
  }

  addFrame(rgba: Uint8ClampedArray): void {
    const word = (value: number) => [value & 255, value >> 8];
    this.parts.push(
      new Uint8Array([0x21, 0xf9, 4, 0, ...word(this.delayCentiseconds), 0, 0]),
      new Uint8Array([0x2c, 0, 0, 0, 0, ...word(this.width), ...word(this.height), 0]),
      compress(quantize(rgba, this.width, this.height)),
    );
  }

  finish(): Blob {
    return new Blob([...this.parts, new Uint8Array([0x3b])] as BlobPart[], { type: "image/gif" });
  }
}
