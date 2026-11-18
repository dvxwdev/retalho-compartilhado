import { describe, expect, it } from "vitest";
import { parseCube } from "../src/core/cube";
import { needsGpu } from "../src/core/look";
import { createProject, findSegment, type Segment } from "../src/core/model";
import { copySegment, pasteAttributes, placeMaterial, splitSegment, updateSegment } from "../src/core/ops";

function clip() {
  const project = createProject();
  project.materials.clip = {
    id: "clip",
    kind: "video",
    name: "clip.mp4",
    duration: 10_000_000,
    width: 1920,
    height: 1080,
    hasAudio: false,
  };
  return placeMaterial(project, "clip", 0);
}

const segmentWith = (extra: Partial<Segment>): Segment =>
  ({ adjust: { brightness: 0, contrast: 0, saturation: 0 }, ...extra }) as Segment;

describe("needs gpu", () => {
  it("keeps plain clips on the direct path", () => {
    expect(needsGpu(segmentWith({}))).toBe(false);
  });

  it("keeps what the 2D filter can do on the direct path", () => {
    expect(needsGpu(segmentWith({ adjust: { brightness: 30, contrast: -10, saturation: 20 } }))).toBe(false);
  });

  it("uses the gpu for everything else", () => {
    expect(needsGpu(segmentWith({ adjust: { brightness: 0, contrast: 0, saturation: 0, temperature: 10 } }))).toBe(true);
    expect(needsGpu(segmentWith({ lut: { id: "a", strength: 1 } }))).toBe(true);
    expect(needsGpu(segmentWith({ chroma: { color: "#00ff00", strength: 0.4, softness: 0.1, spill: 0.5 } }))).toBe(true);
    expect(needsGpu(segmentWith({ effects: { blur: 0.5 } }))).toBe(true);
  });

  it("goes back when an effect is turned down to nothing", () => {
    expect(needsGpu(segmentWith({ effects: { blur: 0 } }))).toBe(false);
    expect(needsGpu(segmentWith({ adjust: { brightness: 0, contrast: 0, saturation: 0, vignette: 0 } }))).toBe(false);
  });
});

describe("look on clips", () => {
  it("follows splits and paste attributes", () => {
    const { project, segmentId } = clip();
    const styled = updateSegment(project, segmentId, (segment) => {
      segment.adjust.temperature = 30;
      segment.effects = { glow: 0.5 };
      segment.chroma = { color: "#00ff00", strength: 0.4, softness: 0.1, spill: 0.5 };
      segment.lut = { id: "lut", strength: 0.7 };
    });
    const split = splitSegment(styled, segmentId, 5_000_000)!;
    expect(findSegment(split.project, split.rightId)!.segment.effects?.glow).toBe(0.5);
    const other = placeMaterial(styled, "clip", 20_000_000);
    const pasted = pasteAttributes(other.project, other.segmentId, copySegment(styled, segmentId)!.segment);
    const target = findSegment(pasted, other.segmentId)!.segment;
    expect(target.adjust.temperature).toBe(30);
    expect(target.lut?.strength).toBe(0.7);
    expect(target.chroma?.color).toBe("#00ff00");
    expect(target.effects?.glow).toBe(0.5);
  });
});

describe("cube files", () => {
  const identity = `# comentário
TITLE "Teste"
LUT_3D_SIZE 2

0 0 0
1 0 0
0 1 0
1 1 0
0 0 1
1 0 1
0 1 1
1 1 1
`;

  it("reads size and values with red changing fastest", () => {
    const { size, data } = parseCube(identity);
    expect(size).toBe(2);
    expect(data.length).toBe(24);
    expect([...data.subarray(3, 6)]).toEqual([1, 0, 0]);
    expect([...data.subarray(6, 9)]).toEqual([0, 1, 0]);
  });

  it("accepts Windows line ends", () => {
    expect(parseCube(identity.replace(/\n/g, "\r\n")).size).toBe(2);
  });

  it("scales values from a custom domain", () => {
    const content = identity.replace("LUT_3D_SIZE 2", "LUT_3D_SIZE 2\nDOMAIN_MIN 0 0 0\nDOMAIN_MAX 2 2 2");
    expect(parseCube(content).data[3]).toBe(0.5);
  });

  it("explains why a file cannot be used", () => {
    expect(() => parseCube("LUT_1D_SIZE 4")).toThrow("1D");
    expect(() => parseCube("isto não é um lut")).toThrow("tamanho");
    expect(() => parseCube("LUT_3D_SIZE 2\n0 0 0\n1 1 1")).toThrow("incompleto");
    expect(() => parseCube(identity.replace("1 1 1", "1 x 1"))).toThrow("corrompido");
  });
});
