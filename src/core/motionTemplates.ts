import { newId, type Project, type Segment, type ShapeMaterial, type TextMaterial, type Us } from "./model";
import { addShapeMaterial, addTextMaterial, placeMaterial, setGroup, updateMaterial, updateSegment } from "./ops";

export type MotionTemplate = "lowerThird" | "title" | "callout" | "endCard";

export const MOTION_TEMPLATES: { value: MotionTemplate; label: string }[] = [
  { value: "lowerThird", label: "Terço inferior" },
  { value: "title", label: "Título" },
  { value: "callout", label: "Destaque" },
  { value: "endCard", label: "Encerramento" },
];

const SECOND: Us = 1_000_000;
const HALF: Us = SECOND / 2;
const CLIP_LENGTH: Us = 4 * SECOND;

interface Piece {
  shape?: ShapeMaterial["shape"];
  look?: Partial<ShapeMaterial>;
  text?: string;
  style?: Partial<TextMaterial>;
  clip: (segment: Segment) => void;
}

const PIECES: Record<MotionTemplate, Piece[]> = {
  lowerThird: [
    {
      shape: "rectangle",
      look: { width: 0.9, height: 0.17, fill: "#f2a33a", fill2: "#d9642b", gradientAngle: 0, radius: 0.12 },
      clip: (segment) => {
        segment.transform.x = -0.5;
        segment.transform.y = -0.68;
        segment.animIn = { type: "left", duration: HALF };
        segment.animOut = { type: "left", duration: HALF };
      },
    },
    {
      text: "Seu nome aqui",
      style: { fontSize: 60, color: "#1d1404" },
      clip: (segment) => {
        segment.transform.x = -0.5;
        segment.transform.y = -0.68;
        segment.letters = { type: "rise", order: "forward", duration: 400_000, stagger: 30_000 };
        segment.animOut = { type: "fade", duration: HALF };
      },
    },
  ],
  title: [
    {
      text: "SEU TÍTULO",
      style: { fontSize: 150, fontFamily: "Impact", bold: false, letterSpacing: 6 },
      clip: (segment) => {
        segment.transform.y = 0.08;
        segment.letters = { type: "pop", order: "center", duration: 500_000, stagger: 40_000 };
        segment.animOut = { type: "zoom", duration: HALF };
      },
    },
    {
      shape: "line",
      look: { width: 0.9, height: 0.02, stroke: "#f2a33a", strokeWidth: 10 },
      clip: (segment) => {
        segment.transform.y = -0.16;
        segment.animIn = { type: "draw", duration: 800_000 };
        segment.animOut = { type: "fade", duration: HALF };
      },
    },
  ],
  callout: [
    {
      shape: "circle",
      look: { width: 0.34, height: 0.34, fill: "", stroke: "#f2a33a", strokeWidth: 12 },
      clip: (segment) => {
        segment.animIn = { type: "draw", duration: 700_000 };
        segment.animLoop = { type: "pulse", duration: SECOND };
        segment.animOut = { type: "fade", duration: HALF };
      },
    },
    {
      text: "Olhe aqui",
      style: { fontSize: 56, strokeWidth: 5 },
      clip: (segment) => {
        segment.transform.y = -0.48;
        segment.animIn = { type: "pop", duration: HALF };
        segment.animOut = { type: "fade", duration: HALF };
      },
    },
  ],
  endCard: [
    {
      shape: "rectangle",
      look: { width: 2, height: 2, fill: "#121316", fill2: "#2e2a4a", gradientAngle: 45 },
      clip: (segment) => {
        segment.animIn = { type: "fade", duration: HALF };
      },
    },
    {
      text: "Obrigado por assistir",
      style: { fontSize: 90 },
      clip: (segment) => {
        segment.transform.y = 0.1;
        segment.letters = { type: "rise", order: "forward", duration: 500_000, stagger: 30_000 };
      },
    },
    {
      text: "Siga para mais vídeos",
      style: { fontSize: 44, bold: false, color: "#f2a33a" },
      clip: (segment) => {
        segment.transform.y = -0.14;
        segment.animIn = { type: "fade", duration: SECOND };
      },
    },
  ],
};

function placePiece(project: Project, piece: Piece, at: Us): { project: Project; segmentId: string } {
  const added = piece.shape ? addShapeMaterial(project, piece.shape) : addTextMaterial(project, piece.text);
  const styled = updateMaterial(added.project, added.materialId, { ...(piece.look ?? piece.style) } as never);
  const placed = placeMaterial(styled, added.materialId, at);
  return {
    segmentId: placed.segmentId,
    project: updateSegment(placed.project, placed.segmentId, (segment) => {
      segment.target.duration = CLIP_LENGTH;
      segment.source.duration = CLIP_LENGTH;
      piece.clip(segment);
    }),
  };
}

/** Adds a ready-made animated graphic, as clips grouped to move together. */
export function addMotionTemplate(
  project: Project,
  template: MotionTemplate,
  at: Us,
): { project: Project; segmentIds: string[] } {
  let next = project;
  const segmentIds: string[] = [];
  for (const piece of PIECES[template]) {
    const placed = placePiece(next, piece, at);
    next = placed.project;
    segmentIds.push(placed.segmentId);
  }
  return { project: setGroup(next, segmentIds, newId()), segmentIds };
}
