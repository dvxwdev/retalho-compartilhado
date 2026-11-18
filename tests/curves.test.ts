import { describe, expect, it } from "vitest";
import { curveTable, hasCurves, hasHsl, isIdentityCurve, type CurvePoint } from "../src/core/curves";
import { needsGpu } from "../src/core/look";
import type { Segment } from "../src/core/model";

const at = (table: Float32Array, x: number) => table[Math.round(x * 255)]!;

describe("colour curves", () => {
  it("leaves colours alone by default", () => {
    const table = curveTable([[0, 0], [1, 1]]);
    expect(at(table, 0)).toBe(0);
    expect(at(table, 0.5)).toBeCloseTo(0.5, 2);
    expect(at(table, 1)).toBe(1);
  });

  it("passes exactly through the points", () => {
    const table = curveTable([[0, 0], [0.5, 0.8], [1, 1]]);
    expect(at(table, 0.5)).toBeCloseTo(0.8, 1);
  });

  it("never overshoots between points", () => {
    const steep: CurvePoint[] = [[0, 0], [0.45, 0.05], [0.55, 0.95], [1, 1]];
    const table = curveTable(steep);
    for (let index = 1; index < table.length; index += 1) {
      expect(table[index]!).toBeGreaterThanOrEqual(table[index - 1]! - 1e-6);
    }
    expect(Math.max(...table)).toBeLessThanOrEqual(1);
    expect(Math.min(...table)).toBeGreaterThanOrEqual(0);
  });

  it("holds flat outside the first and last points", () => {
    const table = curveTable([[0.2, 0.3], [0.8, 0.7]]);
    expect(at(table, 0)).toBeCloseTo(0.3);
    expect(at(table, 1)).toBeCloseTo(0.7);
  });

  it("accepts points in any order", () => {
    expect(curveTable([[1, 1], [0, 0], [0.5, 0.2]])).toEqual(curveTable([[0, 0], [0.5, 0.2], [1, 1]]));
  });

  it("recognises a curve that does nothing", () => {
    expect(isIdentityCurve(undefined)).toBe(true);
    expect(isIdentityCurve([[0, 0], [1, 1]])).toBe(true);
    expect(isIdentityCurve([[0, 0], [0.5, 0.7], [1, 1]])).toBe(false);
  });
});

describe("which clips need the gpu", () => {
  const base = { adjust: { brightness: 0, contrast: 0, saturation: 0 } } as Segment;

  it("stays on the direct path while curves and hsl do nothing", () => {
    expect(hasCurves({ master: [[0, 0], [1, 1]] })).toBe(false);
    expect(hasHsl({ red: { hue: 0, saturation: 0, lightness: 0 } })).toBe(false);
    expect(needsGpu({ ...base, curves: { red: [[0, 0], [1, 1]] }, hsl: { red: { hue: 0, saturation: 0, lightness: 0 } } })).toBe(false);
  });

  it("goes through the gpu once they change something", () => {
    expect(needsGpu({ ...base, curves: { master: [[0, 0], [0.5, 0.7], [1, 1]] } })).toBe(true);
    expect(needsGpu({ ...base, hsl: { blue: { hue: 30, saturation: 0, lightness: 0 } } })).toBe(true);
  });
});
