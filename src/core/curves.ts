/** Colour curves: control points in, a 256-step table out, ready for the GPU. */
export const CURVE_CHANNELS = ["master", "red", "green", "blue"] as const;
export type CurveChannel = (typeof CURVE_CHANNELS)[number];

/** Input and output from 0 to 1. */
export type CurvePoint = [x: number, y: number];

export type Curves = Partial<Record<CurveChannel, CurvePoint[]>>;

export const IDENTITY_CURVE: CurvePoint[] = [
  [0, 0],
  [1, 1],
];

const STEPS = 256;

/**
 * A smooth curve through the points that never overshoots between them, so a
 * dragged point cannot make a colour wrap around (monotone cubic interpolation).
 */
export function curveTable(points: CurvePoint[]): Float32Array {
  const sorted = [...points].sort((a, b) => a[0] - b[0]);
  const count = sorted.length;
  const slopes: number[] = [];
  for (let index = 0; index < count - 1; index += 1) {
    const span = sorted[index + 1]![0] - sorted[index]![0];
    slopes.push(span > 0 ? (sorted[index + 1]![1] - sorted[index]![1]) / span : 0);
  }
  const tangents = sorted.map((_, index) => {
    if (index === 0) return slopes[0] ?? 0;
    if (index === count - 1) return slopes[count - 2] ?? 0;
    const before = slopes[index - 1]!;
    const after = slopes[index]!;
    return before * after <= 0 ? 0 : (2 * before * after) / (before + after);
  });

  const table = new Float32Array(STEPS);
  for (let step = 0; step < STEPS; step += 1) {
    const x = step / (STEPS - 1);
    if (x <= sorted[0]![0]) {
      table[step] = sorted[0]![1];
      continue;
    }
    if (x >= sorted[count - 1]![0]) {
      table[step] = sorted[count - 1]![1];
      continue;
    }
    let segment = 0;
    while (x > sorted[segment + 1]![0]) segment += 1;
    const [x0, y0] = sorted[segment]!;
    const [x1, y1] = sorted[segment + 1]!;
    const span = x1 - x0;
    const t = span > 0 ? (x - x0) / span : 0;
    const t2 = t * t;
    const t3 = t2 * t;
    const value =
      (2 * t3 - 3 * t2 + 1) * y0 +
      (t3 - 2 * t2 + t) * span * tangents[segment]! +
      (-2 * t3 + 3 * t2) * y1 +
      (t3 - t2) * span * tangents[segment + 1]!;
    table[step] = Math.min(1, Math.max(0, value));
  }
  return table;
}

export function isIdentityCurve(points: CurvePoint[] | undefined): boolean {
  return !points || (points.length === 2 && points[0]![0] === 0 && points[0]![1] === 0 && points[1]![0] === 1 && points[1]![1] === 1);
}

export const HSL_COLORS = ["red", "orange", "yellow", "green", "cyan", "blue", "purple", "magenta"] as const;
export type HslColor = (typeof HSL_COLORS)[number];

/** Each in -100..100; 0 leaves that colour alone. */
export interface HslShift {
  hue: number;
  saturation: number;
  lightness: number;
}

export type HslAdjust = Partial<Record<HslColor, HslShift>>;

export function hasHsl(hsl: HslAdjust | undefined): boolean {
  return Object.values(hsl ?? {}).some(({ hue, saturation, lightness }) => hue || saturation || lightness);
}

export function hasCurves(curves: Curves | undefined): boolean {
  return Object.values(curves ?? {}).some((points) => !isIdentityCurve(points));
}
