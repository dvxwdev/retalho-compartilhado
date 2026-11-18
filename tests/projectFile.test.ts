import { describe, expect, it } from "vitest";
import { createProject } from "../src/core/model";
import { addTextMaterial, placeMaterial, toggleMarker } from "../src/core/ops";
import { packProject, unpackProject } from "../src/core/projectFile";

function sample() {
  const added = addTextMaterial(createProject("Meu vídeo"), "Olá ✓");
  return toggleMarker(placeMaterial(added.project, added.materialId, 0).project, 1_000_000);
}

describe("project file", () => {
  it("brings back the project and each file, in order and with its type", async () => {
    const project = sample();
    const media = [
      { id: "a", blob: new Blob([new Uint8Array([1, 2, 3])], { type: "video/mp4" }) },
      { id: "b", blob: new Blob([new Uint8Array([9, 8])], { type: "image/png" }) },
    ];
    const opened = await unpackProject(packProject(project, media));
    expect(opened.project).toEqual(project);
    expect(opened.media.map((item) => [item.id, item.blob.type, item.blob.size])).toEqual([
      ["a", "video/mp4", 3],
      ["b", "image/png", 2],
    ]);
    expect([...new Uint8Array(await opened.media[1]!.blob.arrayBuffer())]).toEqual([9, 8]);
  });

  it("works without media", async () => {
    const opened = await unpackProject(packProject(sample(), []));
    expect(opened.media).toEqual([]);
  });

  it("refuses files that are not projects", async () => {
    await expect(unpackProject(new Blob(["oi"]))).rejects.toThrow("não é um projeto");
    await expect(unpackProject(new Blob(["qualquer coisa bem maior que o prefixo"]))).rejects.toThrow("não é um projeto");
  });

  it("refuses a truncated file", async () => {
    const whole = packProject(sample(), [{ id: "a", blob: new Blob([new Uint8Array(100)]) }]);
    await expect(unpackProject(whole.slice(0, whole.size - 10))).rejects.toThrow("corrompido");
    await expect(unpackProject(whole.slice(0, 20))).rejects.toThrow("corrompido");
  });

  it("refuses a valid wrapper around something else", async () => {
    const wrong = packProject({ format: "outro" } as never, []);
    await expect(unpackProject(wrong)).rejects.toThrow("corrompido");
  });
});
