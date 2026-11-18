/** A 3D colour table, with red changing fastest, as the .cube format stores it. */
export interface LutTable {
  size: number;
  /** RGB triplets from 0 to 1. */
  data: Float32Array;
}

const MAX_SIZE = 65;

/** Reads the Adobe .cube format. Throws a message for the user when the file cannot be used. */
export function parseCube(content: string): LutTable {
  let size = 0;
  let low = [0, 0, 0];
  let high = [1, 1, 1];
  const values: number[] = [];

  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const [word, ...rest] = line.split(/\s+/);
    if (word === "LUT_1D_SIZE") throw new Error("este LUT é 1D, e só LUTs 3D são compatíveis");
    if (word === "LUT_3D_SIZE") size = Number(rest[0]);
    else if (word === "DOMAIN_MIN") low = rest.map(Number);
    else if (word === "DOMAIN_MAX") high = rest.map(Number);
    else if (/^[-+.\d]/.test(word!)) values.push(Number(word), Number(rest[0]), Number(rest[1]));
  }

  if (!Number.isInteger(size) || size < 2 || size > MAX_SIZE) throw new Error("tamanho de LUT inválido");
  if (values.length !== size ** 3 * 3 || values.some(Number.isNaN)) {
    throw new Error("o arquivo está incompleto ou corrompido");
  }
  const data = new Float32Array(values.length);
  for (let index = 0; index < values.length; index += 1) {
    const channel = index % 3;
    const span = high[channel]! - low[channel]!;
    data[index] = span > 0 ? (values[index]! - low[channel]!) / span : values[index]!;
  }
  return { size, data };
}
