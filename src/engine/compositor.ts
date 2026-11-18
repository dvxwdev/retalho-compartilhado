import { letterState, type LetterAnimation } from "../core/letters";
import { needsGpu } from "../core/look";
import { spokenRange, spokenWord } from "../core/speech";
import {
  SECOND,
  croppedSize,
  isMediaMaterial,
  type Adjust,
  type ClipFrame,
  type Crop,
  type Mask,
  type MaskShape,
  type Project,
  type ShapeMaterial,
  type TextMaterial,
  type Us,
} from "../core/model";
import type { Layer } from "../core/resolve";
import { renderLook } from "./gpu";
import { pool } from "./media";

type Context = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export interface Box {
  /** Centre and size in project canvas pixels. */
  cx: number;
  cy: number;
  width: number;
  height: number;
  rotation: number;
}

const DEFAULT_LINE_HEIGHT = 1.25;
const DEFAULT_BACKGROUND_PADDING = 0.25;
/** Space around the word being said inside its box, in font sizes. */
const SPOKEN_BOX_PADDING = 0.12;
const BLUR_OVERSCAN = 1.15;
const MAX_GPU_SIZE = 4096;

const measureContext = new OffscreenCanvas(1, 1).getContext("2d")!;

function textUnit(project: Project): number {
  return Math.min(project.canvas.width, project.canvas.height) / 1080;
}

function fontOf(material: TextMaterial, size: number): string {
  const style = `${material.italic ? "italic " : ""}${material.bold ? "bold " : ""}`;
  return `${style}${size}px ${JSON.stringify(material.fontFamily)}, sans-serif`;
}

function setLetters(context: Context, material: TextMaterial, size: number, unit: number): void {
  context.font = fontOf(material, size);
  context.letterSpacing = `${(material.letterSpacing ?? 0) * unit}px`;
}

function measureText(material: TextMaterial, size: number, unit: number) {
  setLetters(measureContext, material, size, unit);
  const lines = material.text.split("\n");
  const widths = lines.map((line) => measureContext.measureText(line).width);
  const width = Math.max(1, ...widths);
  const lineHeight = size * (material.lineHeight ?? DEFAULT_LINE_HEIGHT);
  return { lines, widths, width, lineHeight, height: lineHeight * lines.length };
}

function intrinsicSize(layer: Layer, project: Project): { width: number; height: number } {
  const { material } = layer;
  if (material.kind === "text") {
    const unit = textUnit(project);
    const { width, height } = measureText(material, material.fontSize * unit, unit);
    return { width, height };
  }
  const { width: canvasWidth, height: canvasHeight } = project.canvas;
  if (material.kind === "adjustment") return { width: canvasWidth, height: canvasHeight };
  if (material.kind === "shape") {
    const side = Math.min(canvasWidth, canvasHeight);
    return { width: material.width * side, height: material.height * side };
  }
  if (!material.width || !material.height) return { width: canvasWidth, height: canvasHeight };
  const visible = croppedSize(material.width, material.height, layer.segment.crop);
  // Cover fills the canvas; whatever reaches past its edges is simply not seen.
  const pick = layer.segment.fit === "cover" ? Math.max : Math.min;
  const fit = pick(canvasWidth / visible.width, canvasHeight / visible.height);
  return { width: visible.width * fit, height: visible.height * fit };
}

export function layerBox(layer: Layer, project: Project): Box {
  const { width, height } = intrinsicSize(layer, project);
  const { x, y, scale, rotation } = layer.transform;
  return {
    cx: project.canvas.width / 2 + (x * project.canvas.width) / 2,
    cy: project.canvas.height / 2 - (y * project.canvas.height) / 2,
    width: width * scale,
    height: height * scale,
    rotation,
  };
}

/** Whether a point in project canvas pixels falls inside the rotated box. */
export function boxContains(box: Box, px: number, py: number): boolean {
  const angle = (-box.rotation * Math.PI) / 180;
  const dx = px - box.cx;
  const dy = py - box.cy;
  const localX = dx * Math.cos(angle) - dy * Math.sin(angle);
  const localY = dx * Math.sin(angle) + dy * Math.cos(angle);
  return Math.abs(localX) <= box.width / 2 && Math.abs(localY) <= box.height / 2;
}

function filterOf(adjust: Adjust): string {
  if (!adjust.brightness && !adjust.contrast && !adjust.saturation) return "none";
  const brightness = 1 + adjust.brightness / 100;
  const contrast = 1 + adjust.contrast / 100;
  const saturation = 1 + adjust.saturation / 100;
  return `brightness(${brightness}) contrast(${contrast}) saturate(${saturation})`;
}

/**
 * Paints one run of glyphs. Canvas shadows ignore the transform, so they are
 * sized in output pixels, and only the first pass casts one.
 */
function paintGlyphs(
  context: Context,
  material: TextMaterial,
  glyphs: string,
  x: number,
  y: number,
  unit: number,
  pixelScale: number,
): void {
  const { shadow } = material;
  if (shadow) {
    const angle = (shadow.angle * Math.PI) / 180;
    context.shadowColor = shadow.color;
    context.shadowBlur = shadow.blur * pixelScale;
    context.shadowOffsetX = Math.cos(angle) * shadow.distance * pixelScale;
    context.shadowOffsetY = Math.sin(angle) * shadow.distance * pixelScale;
  }
  if (material.strokeWidth > 0) {
    context.strokeStyle = material.strokeColor;
    context.lineWidth = material.strokeWidth * unit * 2;
    context.strokeText(glyphs, x, y);
    context.shadowColor = "transparent";
  }
  context.fillStyle = material.color;
  context.fillText(glyphs, x, y);
  context.shadowColor = "transparent";
}

/** Places each letter on an arc through the centre of the line. */
function paintCurvedLine(
  context: Context,
  material: TextMaterial,
  letters: string[],
  lineWidth: number,
  fullWidth: number,
  y: number,
  unit: number,
  pixelScale: number,
): void {
  const curve = material.curve!;
  const direction = Math.sign(curve);
  const radius = fullWidth / ((Math.abs(curve) * Math.PI) / 180);
  const ring = radius - direction * y;
  let along = -lineWidth / 2;
  context.textAlign = "center";
  for (const letter of letters) {
    const advance = context.measureText(letter).width;
    const angle = (along + advance / 2) / radius;
    context.save();
    context.translate(ring * Math.sin(angle), direction * (radius - ring * Math.cos(angle)));
    context.rotate(direction * angle);
    paintGlyphs(context, material, letter, 0, 0, unit, pixelScale);
    context.restore();
    along += advance;
  }
}

/** Draws a line letter by letter, each in the place the animation gives it. */
function paintAnimatedLine(
  context: Context,
  material: TextMaterial,
  letters: string[],
  x: number,
  y: number,
  size: number,
  unit: number,
  pixelScale: number,
  animation: LetterAnimation,
  firstIndex: number,
  total: number,
  time: Us,
): void {
  const fullOpacity = context.globalAlpha;
  letters.forEach((letter, index) => {
    const state = letterState(animation, firstIndex + index, total, time);
    if (state.opacity <= 0) return;
    const before = context.measureText(letters.slice(0, index).join("")).width;
    const width = context.measureText(letter).width;
    context.save();
    context.translate(x + before + width / 2 + state.x * size, y + state.y * size);
    context.rotate((state.rotation * Math.PI) / 180);
    context.scale(state.scale, state.scale);
    context.globalAlpha = fullOpacity * state.opacity;
    paintGlyphs(context, material, letter, -width / 2, 0, unit, pixelScale);
    context.restore();
  });
}

/** The word being said, centred on a point: its box, then the word in its colour and size. */
function paintSpokenWord(
  context: Context,
  material: TextMaterial,
  word: string,
  centerX: number,
  y: number,
  wordWidth: number,
  size: number,
  unit: number,
  pixelScale: number,
  highlight: { color: string; scale?: number; box?: string },
): void {
  const grow = highlight.scale ?? 1;
  context.save();
  context.translate(centerX, y);
  context.scale(grow, grow);
  if (highlight.box) {
    const pad = size * SPOKEN_BOX_PADDING;
    const boxHeight = size * 1.08 + pad;
    context.fillStyle = highlight.box;
    context.beginPath();
    context.roundRect(-wordWidth / 2 - pad, -boxHeight / 2, wordWidth + pad * 2, boxHeight, size * 0.18);
    context.fill();
  }
  paintGlyphs(context, { ...material, color: highlight.color }, word, -wordWidth / 2, 0, unit, pixelScale * grow);
  context.restore();
}

function drawText(
  context: Context,
  material: TextMaterial,
  size: number,
  unit: number,
  pixelScale: number,
  reveal: number,
  animation: LetterAnimation | undefined,
  time: Us,
  highlight: { start: number; end: number; color: string; scale?: number; box?: string } | null,
): void {
  const { lines, widths, width, lineHeight, height } = measureText(material, size, unit);
  setLetters(context, material, size, unit);
  context.textBaseline = "middle";
  context.textAlign = "left";
  context.lineJoin = "round";
  if (material.background) {
    const padX = size * (material.backgroundPadding ?? DEFAULT_BACKGROUND_PADDING);
    const padY = padX / 2;
    const boxHeight = height + padY * 2;
    const radius = Math.max(0, Math.min(1, material.backgroundRadius ?? 0)) * (boxHeight / 2);
    context.fillStyle = material.background;
    context.beginPath();
    context.roundRect(-width / 2 - padX, -height / 2 - padY, width + padX * 2, boxHeight, radius);
    context.fill();
  }
  // Counting code points keeps a surrogate pair, like most emoji, from being cut in half.
  const perLine = lines.map((line) => Array.from(line));
  const total = perLine.reduce((sum, letters) => sum + letters.length, 0);
  let visible = Math.round(total * reveal);
  let firstLetter = 0;
  let lineStart = 0;
  perLine.forEach((letters, index) => {
    const shown = letters.slice(0, Math.max(0, visible));
    visible -= letters.length;
    if (shown.length === 0) return;
    const lineWidth = widths[index]!;
    const y = -height / 2 + lineHeight * (index + 0.5);
    if (material.curve) {
      paintCurvedLine(context, material, shown, lineWidth, width, y, unit, pixelScale);
      return;
    }
    // Lines start from a fixed edge, so text does not slide while it is being revealed.
    const x = material.align === "center" ? -lineWidth / 2 : material.align === "left" ? -width / 2 : width / 2 - lineWidth;
    const line = lines[index]!;
    const grow = highlight?.scale ?? 1;
    const inLine = highlight && highlight.start >= lineStart && highlight.end <= lineStart + line.length;
    if (inLine && grow !== 1 && !animation && shown.length === letters.length) {
      // A grown word pushes its neighbours aside, so they never run into it.
      const from = highlight.start - lineStart;
      const to = highlight.end - lineStart;
      const before = line.slice(0, from);
      const word = line.slice(from, to);
      const after = line.slice(to);
      const beforeWidth = context.measureText(before).width;
      const wordWidth = context.measureText(word).width;
      const grownWidth = lineWidth + wordWidth * (grow - 1);
      const start = material.align === "center" ? -grownWidth / 2 : material.align === "left" ? -width / 2 : width / 2 - grownWidth;
      if (before) paintGlyphs(context, material, before, start, y, unit, pixelScale);
      if (after) paintGlyphs(context, material, after, start + beforeWidth + wordWidth * grow, y, unit, pixelScale);
      paintSpokenWord(context, material, word, start + beforeWidth + (wordWidth * grow) / 2, y, wordWidth, size, unit, pixelScale, highlight);
      lineStart += line.length + 1;
      firstLetter += letters.length;
      return;
    }
    if (animation) {
      paintAnimatedLine(context, material, shown, x, y, size, unit, pixelScale, animation, firstLetter, total, time);
    } else {
      paintGlyphs(context, material, shown.join(""), x, y, unit, pixelScale);
    }
    if (inLine) {
      const from = highlight.start - lineStart;
      const before = context.measureText(line.slice(0, from)).width;
      const word = line.slice(from, highlight.end - lineStart);
      const wordWidth = context.measureText(word).width;
      // While letters are still animating, the word swells in place over the line as drawn.
      paintSpokenWord(context, material, word, x + before + wordWidth / 2, y, wordWidth, size, unit, pixelScale, highlight);
    }
    lineStart += line.length + 1;
    firstLetter += letters.length;
  });
}

function drawOffline(context: Context, width: number, height: number, name: string): void {
  context.fillStyle = "#3a2024";
  context.fillRect(-width / 2, -height / 2, width, height);
  context.fillStyle = "#f2b8b5";
  context.font = `${Math.max(14, height * 0.05)}px sans-serif`;
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(`Mídia offline: ${name}`, 0, 0, width * 0.9);
}

type Source = HTMLVideoElement | ImageBitmap;

function sourceOf(layer: Layer): Source | undefined {
  const { material } = layer;
  if (material.kind === "image") return pool.image(material.id);
  if (material.kind === "video") return pool.videoFor(layer.segment.id, material) ?? undefined;
  return undefined;
}

function naturalSize(source: Source): { width: number; height: number } {
  return source instanceof ImageBitmap
    ? { width: source.width, height: source.height }
    : { width: source.videoWidth, height: source.videoHeight };
}

/** Draws a source centred in a box, showing only what the crop keeps. */
function drawSource(context: Context, source: Source, width: number, height: number, crop?: Crop): void {
  const x = -width / 2;
  const y = -height / 2;
  if (!crop) {
    context.drawImage(source, x, y, width, height);
    return;
  }
  const natural = naturalSize(source);
  const visible = croppedSize(natural.width, natural.height, crop);
  if (!visible.width || !visible.height) return;
  context.drawImage(
    source,
    natural.width * crop.left,
    natural.height * crop.top,
    visible.width,
    visible.height,
    x,
    y,
    width,
    height,
  );
}

/** Fills the output while keeping proportions; overscan hides the soft edge of a blur. */
function drawCover(context: Context, source: Source, width: number, height: number, overscan = 1): void {
  const natural = naturalSize(source);
  if (!natural.width || !natural.height) return;
  const scale = Math.max(width / natural.width, height / natural.height) * overscan;
  const drawnWidth = natural.width * scale;
  const drawnHeight = natural.height * scale;
  context.drawImage(source, (width - drawnWidth) / 2, (height - drawnHeight) / 2, drawnWidth, drawnHeight);
}

/** Works in output pixels, which keeps a blur the same size in preview and export. */
function drawBackground(
  context: Context,
  width: number,
  height: number,
  project: Project,
  layers: Layer[],
): void {
  const { background } = project;
  context.fillStyle = background?.kind === "color" ? background.color : "#000";
  context.fillRect(0, 0, width, height);
  if (background?.kind === "image") {
    const image = pool.image(background.materialId);
    if (image) drawCover(context, image, width, height);
  } else if (background?.kind === "blur") {
    const bottom = layers.map(sourceOf).find(Boolean);
    if (!bottom) return;
    context.filter = `blur(${(background.amount * Math.min(width, height)) / 1080}px)`;
    drawCover(context, bottom, width, height, BLUR_OVERSCAN);
    context.filter = "none";
  }
}

/** Bézier points of a heart, in a box from -1 to 1. */
const HEART: number[][] = [
  [0, -0.45],
  [-0.25, -1, -1, -0.95, -1, -0.3],
  [-1, 0.25, -0.35, 0.6, 0, 1],
  [0.35, 0.6, 1, 0.25, 1, -0.3],
  [1, -0.95, 0.25, -1, 0, -0.45],
];

const STAR_POINTS = 5;
const STAR_INNER_RADIUS = 0.45;

/** A shape centred on the origin. A linear mask is the half plane below its line. */
function maskPath(shape: MaskShape, width: number, height: number, reach: number): Path2D {
  const path = new Path2D();
  const halfWidth = width / 2;
  const halfHeight = height / 2;
  switch (shape) {
    case "linear":
      path.rect(-reach, 0, reach * 2, reach);
      break;
    case "rectangle":
      path.rect(-halfWidth, -halfHeight, width, height);
      break;
    case "circle":
      path.ellipse(0, 0, halfWidth, halfHeight, 0, 0, Math.PI * 2);
      break;
    case "heart": {
      const [start, ...curves] = HEART;
      path.moveTo(start![0]! * halfWidth, start![1]! * halfHeight);
      for (const [x1, y1, x2, y2, x, y] of curves) {
        path.bezierCurveTo(
          x1! * halfWidth,
          y1! * halfHeight,
          x2! * halfWidth,
          y2! * halfHeight,
          x! * halfWidth,
          y! * halfHeight,
        );
      }
      path.closePath();
      break;
    }
    case "star":
      for (let index = 0; index < STAR_POINTS * 2; index += 1) {
        const radius = index % 2 ? STAR_INNER_RADIUS : 1;
        const angle = (index * Math.PI) / STAR_POINTS - Math.PI / 2;
        path.lineTo(Math.cos(angle) * radius * halfWidth, Math.sin(angle) * radius * halfHeight);
      }
      path.closePath();
      break;
  }
  return path;
}

function shapePath(material: ShapeMaterial, width: number, height: number): Path2D {
  const path = new Path2D();
  const halfWidth = width / 2;
  const halfHeight = height / 2;
  switch (material.shape) {
    case "rectangle":
      path.roundRect(-halfWidth, -halfHeight, width, height, material.radius * Math.min(width, height));
      return path;
    case "triangle":
      path.moveTo(0, -halfHeight);
      path.lineTo(halfWidth, halfHeight);
      path.lineTo(-halfWidth, halfHeight);
      path.closePath();
      return path;
    case "line":
      path.moveTo(-halfWidth, 0);
      path.lineTo(halfWidth, 0);
      return path;
    default:
      return maskPath(material.shape, width, height, 0);
  }
}

/** Reveal below 1 traces the outline, while the inside fades in with it. */
function drawShape(context: Context, material: ShapeMaterial, width: number, height: number, reveal: number, unit: number): void {
  const path = shapePath(material, width, height);
  if (material.fill) {
    const angle = (material.gradientAngle * Math.PI) / 180;
    const reachX = (Math.cos(angle) * width) / 2;
    const reachY = (Math.sin(angle) * height) / 2;
    const gradient = context.createLinearGradient(-reachX, -reachY, reachX, reachY);
    gradient.addColorStop(0, material.fill);
    gradient.addColorStop(1, material.fill2 || material.fill);
    const fullOpacity = context.globalAlpha;
    context.globalAlpha = fullOpacity * reveal;
    context.fillStyle = gradient;
    context.fill(path);
    context.globalAlpha = fullOpacity;
  }
  if (material.strokeWidth > 0) {
    context.strokeStyle = material.stroke;
    context.lineWidth = material.strokeWidth * unit;
    context.lineCap = "round";
    context.lineJoin = "round";
    if (reveal < 1) {
      const outline = (width + height) * 2.2;
      context.setLineDash([outline * reveal, outline]);
    }
    if (reveal > 0) context.stroke(path);
    context.setLineDash([]);
  }
}

/** Keeps only what the mask covers, on a context already placed at the clip's centre. */
function applyMask(context: Context, mask: Mask, box: Box, outputScale: number): void {
  const reach = Math.max(box.width, box.height) * 4;
  const shortSide = Math.min(box.width, box.height);
  context.save();
  context.translate((mask.x * box.width) / 2, (-mask.y * box.height) / 2);
  context.rotate((mask.rotation * Math.PI) / 180);
  context.globalAlpha = 1;
  context.globalCompositeOperation = mask.invert ? "destination-out" : "destination-in";
  context.filter = mask.feather > 0 ? `blur(${mask.feather * shortSide * outputScale}px)` : "none";
  context.fillStyle = "#000";
  context.fill(maskPath(mask.shape, box.width * mask.width, box.height * mask.height, reach));
  context.restore();
}

/** A masked clip is built here first, because masking the frame would erase what is under it. */
const scratches: OffscreenCanvasRenderingContext2D[] = [];

function scratchContext(slot: number, width: number, height: number, transform: DOMMatrix) {
  const scratch = (scratches[slot] ??= new OffscreenCanvas(width, height).getContext("2d")!);
  const { canvas } = scratch;
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  scratch.setTransform(1, 0, 0, 1, 0, 0);
  scratch.globalCompositeOperation = "source-over";
  scratch.clearRect(0, 0, width, height);
  scratch.setTransform(transform);
  return scratch;
}

function frameOutline(box: Box, frame: ClipFrame): Path2D {
  const path = new Path2D();
  const radius = frame.radius * Math.min(box.width, box.height);
  path.roundRect(-box.width / 2, -box.height / 2, box.width, box.height, radius);
  return path;
}

/** Runs a drawing inside a clip's frame, with its shadow under and its outline on top. */
function withFrame(context: Context, frame: ClipFrame | undefined, box: Box, outputScale: number, draw: () => void): void {
  if (!frame) {
    draw();
    return;
  }
  const outline = frameOutline(box, frame);
  const shortSide = Math.min(box.width, box.height);
  if (frame.shadowColor) {
    context.save();
    context.shadowColor = frame.shadowColor;
    context.shadowBlur = frame.shadowSize * shortSide * outputScale;
    context.shadowOffsetY = frame.shadowSize * shortSide * outputScale * 0.4;
    context.fillStyle = "#000";
    context.fill(outline);
    context.restore();
  }
  context.save();
  context.clip(outline);
  draw();
  context.restore();
  if (frame.strokeWidth > 0) {
    context.strokeStyle = frame.strokeColor;
    context.lineWidth = frame.strokeWidth * shortSide;
    context.stroke(outline);
  }
}

/** The clip with its look applied, or null when it has none or the GPU is missing. */
function lookOf(source: Source, layer: Layer, box: Box, outputScale: number): OffscreenCanvas | null {
  const { segment } = layer;
  if (!needsGpu(segment) || !naturalSize(source).width) return null;
  const pixels = (size: number) => Math.max(1, Math.min(MAX_GPU_SIZE, Math.round(size * outputScale)));
  const lut = segment.lut ? pool.lut(segment.lut.id) : undefined;
  return renderLook(source, segment, layer.time / SECOND, lut, pixels(box.width), pixels(box.height));
}

function paintLayer(context: Context, layer: Layer, box: Box, unit: number, outputScale: number): void {
  const { material } = layer;
  context.save();
  if (material.kind === "text") {
    const { scale } = layer.transform;
    context.scale(scale, scale);
    const said = material.timing && material.spoken
      ? spokenWord(material.timing, layer.segment.source.start + layer.time)
      : -1;
    const spoken = material.spoken;
    const single = said >= 0 && spoken?.mode === "single";
    const saidText = single ? material.timing![said]!.text : "";
    const range = said < 0 ? null : single ? { start: 0, end: saidText.length } : spokenRange(material.text, material.timing!, said);
    // A plain recolour is already done by the single-word text itself; size and box need the highlight pass.
    const highlight = range && spoken && (!single || (spoken.scale ?? 1) !== 1 || spoken.box)
      ? { ...range, color: spoken.color, scale: spoken.scale, box: spoken.box || undefined }
      : null;
    drawText(
      context,
      single ? { ...material, text: saidText, color: spoken!.color } : material,
      material.fontSize * unit,
      unit,
      outputScale * scale * unit,
      layer.reveal,
      layer.segment.letters,
      layer.time,
      highlight,
    );
  } else if (material.kind === "shape") {
    drawShape(context, material, box.width, box.height, layer.reveal, unit * layer.transform.scale);
  } else if (isMediaMaterial(material) && material.kind !== "audio") {
    const source = sourceOf(layer);
    const looked = source ? lookOf(source, layer, box, outputScale) : null;
    if (source) {
      withFrame(context, layer.segment.frame, box, outputScale, () => {
        if (looked) {
          context.drawImage(looked, -box.width / 2, -box.height / 2, box.width, box.height);
        } else {
          context.filter = filterOf(layer.segment.adjust);
          drawSource(context, source, box.width, box.height, layer.segment.crop);
          context.filter = "none";
        }
      });
    } else {
      drawOffline(context, box.width, box.height, material.name);
    }
  }
  context.restore();
}

function placeLayer(context: Context, layer: Layer, box: Box, canvasWidth: number): void {
  context.translate(box.cx + layer.offsetX * canvasWidth, box.cy);
  context.rotate((box.rotation * Math.PI) / 180);
  context.scale(layer.segment.flipX ? -1 : 1, layer.segment.flipY ? -1 : 1);
}

/** Runs what has been drawn so far through the clip's look, then lays the result back on top. */
function applyAdjustment(
  context: Context,
  layer: Layer,
  width: number,
  height: number,
  opacity: number,
  projectSpace: DOMMatrix,
): void {
  const { segment } = layer;
  if (!needsGpu(segment)) return;
  const lut = segment.lut ? pool.lut(segment.lut.id) : undefined;
  const looked = renderLook(context.canvas, segment, layer.time / SECOND, lut, width, height);
  if (!looked) return;
  context.save();
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.globalAlpha = opacity;
  context.drawImage(looked, 0, 0, width, height);
  context.restore();
  context.setTransform(projectSpace);
}

/** Draws one frame. Coordinates stay in project pixels, so any output size matches. */
export function drawFrame(
  context: Context,
  outputWidth: number,
  outputHeight: number,
  project: Project,
  layers: Layer[],
): void {
  const { width: canvasWidth, height: canvasHeight } = project.canvas;
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.globalAlpha = 1;
  context.filter = "none";
  drawBackground(context, outputWidth, outputHeight, project, layers);
  context.scale(outputWidth / canvasWidth, outputHeight / canvasHeight);

  const unit = textUnit(project);
  const outputScale = outputWidth / canvasWidth;
  const projectSpace = context.getTransform();
  /** Draws a layer with its mask onto a context of its own, ready to be placed. */
  const paintAlone = (slot: number, layer: Layer, box: Box) => {
    const layerContext = scratchContext(slot, outputWidth, outputHeight, projectSpace);
    layerContext.save();
    placeLayer(layerContext, layer, box, canvasWidth);
    paintLayer(layerContext, layer, box, unit, outputScale);
    if (layer.segment.mask) applyMask(layerContext, layer.segment.mask, box, outputScale);
    layerContext.restore();
    return layerContext;
  };

  for (let index = 0; index < layers.length; index += 1) {
    const layer = layers[index]!;
    const opacity = layer.transform.opacity * layer.opacityMul;
    if (opacity <= 0 || layer.revealX <= 0 || layer.revealCircle <= 0) continue;
    if (layer.material.kind === "adjustment") {
      applyAdjustment(context, layer, outputWidth, outputHeight, opacity, projectSpace);
      continue;
    }
    const box = layerBox(layer, project);
    const matte = layers[index + 1]?.segment.matte ? layers[index + 1]! : null;
    context.save();
    if (layer.revealX < 1) {
      context.beginPath();
      context.rect(0, 0, canvasWidth * layer.revealX, canvasHeight);
      context.clip();
    }
    if (layer.revealCircle < 1) {
      context.beginPath();
      context.arc(canvasWidth / 2, canvasHeight / 2, Math.hypot(canvasWidth, canvasHeight) * 0.5 * layer.revealCircle, 0, Math.PI * 2);
      context.clip();
    }
    context.globalAlpha = opacity;
    context.globalCompositeOperation = layer.segment.blend ?? "source-over";

    if (matte) {
      // Both are drawn apart, because a multi-line text would erase itself one line at a time.
      const shape = paintAlone(1, matte, layerBox(matte, project));
      const layerContext = paintAlone(0, layer, box);
      layerContext.setTransform(1, 0, 0, 1, 0, 0);
      layerContext.globalCompositeOperation = "destination-in";
      layerContext.drawImage(shape.canvas, 0, 0);
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.drawImage(layerContext.canvas, 0, 0);
      index += 1;
    } else if (layer.segment.mask) {
      const layerContext = paintAlone(0, layer, box);
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.drawImage(layerContext.canvas, 0, 0);
    } else {
      placeLayer(context, layer, box, canvasWidth);
      paintLayer(context, layer, box, unit, outputScale);
    }
    context.restore();
  }
}
