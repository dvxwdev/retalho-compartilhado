import type { ClipAnimation, EntranceType, ExitType } from "./animation";
import { findSegment, type Project, type Segment, type TextMaterial } from "./model";
import { updateMaterial, updateSegment } from "./ops";

export type TextStyle = Partial<Omit<TextMaterial, "id" | "kind" | "text" | "fontSize">>;

export interface TextPreset {
  id: string;
  label: string;
  style: TextStyle;
  animIn?: ClipAnimation<EntranceType>;
  animOut?: ClipAnimation<ExitType>;
}

const HALF_SECOND = 500_000;

/** Applied under every preset, so nothing from the previous look lingers. */
const BASE_STYLE: TextStyle = {
  fontFamily: "Arial",
  color: "#ffffff",
  bold: true,
  italic: false,
  strokeColor: "#000000",
  strokeWidth: 0,
  background: "",
  letterSpacing: 0,
  lineHeight: undefined,
  curve: undefined,
  shadow: undefined,
};

export const TEXT_PRESETS: TextPreset[] = [
  { id: "legenda", label: "Legenda", style: { strokeWidth: 5 } },
  {
    id: "destaque",
    label: "Destaque",
    style: { color: "#111111", background: "#ffd400" },
    animIn: { type: "pop", duration: HALF_SECOND },
  },
  {
    id: "titulo",
    label: "Título",
    style: {
      fontFamily: "Impact",
      bold: false,
      letterSpacing: 2,
      shadow: { color: "#000000", blur: 0, distance: 8, angle: 45 },
    },
    animIn: { type: "zoom", duration: HALF_SECOND },
    animOut: { type: "fade", duration: HALF_SECOND },
  },
  {
    id: "neon",
    label: "Neon",
    style: { shadow: { color: "#00e5ff", blur: 30, distance: 0, angle: 0 } },
    animIn: { type: "fade", duration: HALF_SECOND },
    animOut: { type: "fade", duration: HALF_SECOND },
  },
  {
    id: "maquina",
    label: "Máquina",
    style: { fontFamily: "Courier New", bold: false, background: "#111111" },
    animIn: { type: "type", duration: 1_000_000 },
  },
  {
    id: "rodape",
    label: "Rodapé",
    style: { background: "#1f2937" },
    animIn: { type: "left", duration: HALF_SECOND },
    animOut: { type: "left", duration: HALF_SECOND },
  },
  {
    id: "contorno",
    label: "Contorno",
    style: { color: "#ffd400", strokeWidth: 8 },
    animIn: { type: "rise", duration: HALF_SECOND },
  },
  {
    id: "suave",
    label: "Suave",
    style: {
      fontFamily: "Georgia",
      bold: false,
      italic: true,
      shadow: { color: "#000000", blur: 14, distance: 3, angle: 90 },
    },
    animIn: { type: "fade", duration: HALF_SECOND },
    animOut: { type: "fade", duration: HALF_SECOND },
  },
];

/** Restyles a text clip. Its words and size stay, because those belong to the content. */
export function applyTextPreset(project: Project, segmentId: string, preset: TextPreset): Project {
  const found = findSegment(project, segmentId);
  const material = found && project.materials[found.segment.materialId];
  if (!found || found.track.locked || material?.kind !== "text") return project;
  const styled = updateMaterial(project, material.id, { ...BASE_STYLE, ...preset.style });
  return updateSegment(styled, segmentId, (segment) => {
    delete segment.animIn;
    delete segment.animOut;
    if (preset.animIn) segment.animIn = preset.animIn;
    if (preset.animOut) segment.animOut = preset.animOut;
  });
}

/** Sets how the spoken word stands out on every caption made from speech. */
export function setSpokenStyle(project: Project, spoken: TextMaterial["spoken"]): Project {
  const materials = { ...project.materials };
  for (const material of Object.values(materials)) {
    if (material.kind === "text" && material.timing) materials[material.id] = { ...material, spoken };
  }
  return { ...project, materials };
}

/** Gives every text on a track the look and movement of one of them. */
export function matchTrackStyle(project: Project, segmentId: string): Project {
  const found = findSegment(project, segmentId);
  const material = found && project.materials[found.segment.materialId];
  if (!found || found.track.locked || material?.kind !== "text") return project;
  const preset = presetFrom(material, found.segment, "", "");
  return found.track.segments.reduce((next, segment) => {
    if (segment.id === segmentId) return next;
    const styled = applyTextPreset(next, segment.id, preset);
    const sized = updateMaterial(styled, segment.materialId, { fontSize: material.fontSize, align: material.align });
    return updateSegment(sized, segment.id, (item) => {
      item.transform = { ...found.segment.transform };
      if (found.segment.letters) item.letters = found.segment.letters;
      else delete item.letters;
    });
  }, project);
}

/** Captures a clip's look as a preset the user can reuse. */
export function presetFrom(material: TextMaterial, segment: Segment, id: string, label: string): TextPreset {
  const { id: _id, kind: _kind, text: _text, fontSize: _fontSize, align: _align, timing: _timing, ...style } = material;
  return {
    id,
    label,
    style,
    ...(segment.animIn ? { animIn: segment.animIn } : {}),
    ...(segment.animOut ? { animOut: segment.animOut } : {}),
  };
}
