import { useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { ClipAnimation } from "../../core/animation";
import { hasAdjustKeys, hasMoveKeys, sampleProp } from "../../core/keyframes";
import {
  SECOND,
  isMediaMaterial,
  newId,
  type Adjust,
  type AnimatableProp,
  type KeyedProp,
  type AudioEffects,
  type BlendMode,
  type CanvasBackground,
  type ClipFrame,
  type Crop,
  type Easing,
  type Fit,
  type Mask,
  type MaskShape,
  type Material,
  type ShapeKind,
  type ShapeMaterial,
  type Segment,
  type TextMaterial,
  type TrackType,
  type TransitionType,
} from "../../core/model";
import {
  MAX_SPEED,
  MIN_SPEED,
  adjacentNext,
  rotateQuarter,
  setCropEdge,
  setEasing,
  setProp,
  setSpeed,
  setTransition,
  toggleKeyframe,
  updateMaterial,
  updateSegment,
} from "../../core/ops";
import type { Chroma, EffectType } from "../../core/look";
import { hasCurves, hasHsl, type CurveChannel, type HslColor, type HslShift } from "../../core/curves";
import type { LetterAnimation, LetterAnimationType, LetterOrder } from "../../core/letters";
import { MAX_SPOKEN_SCALE } from "../../core/speech";
import { MAX_VOLUME } from "../../core/loudness";
import { MOTION_PRESETS, applyMotion } from "../../core/motion";
import {
  TEXT_PRESETS,
  applyTextPreset,
  matchTrackStyle,
  presetFrom,
  setSpokenStyle,
  type TextPreset,
} from "../../core/textPresets";
import {
  audibleClips,
  cancelSpeech,
  createCaptions,
  cutHesitations,
  cutPauses,
  cutVideoToBeats,
  duckUnderSpeech,
  importFiles,
  markBeats,
  normalizeClips,
  selectedOffset,
  splitScenes,
  transcribeClip,
} from "../actions";
import { gpuAvailable } from "../../engine/gpu";
import type { SpeechModel } from "../../engine/whisper.worker";
import type { IconName } from "../icons";
import { edit, useEditor } from "../store";
import { loadUserPresets, storeUserPresets } from "../userPresets";
import { CurveEditor } from "./CurveEditor";
import { Choice, Field, Group, Sections, SelectField, Swatch, Toggle, type ChoiceOption } from "./controls";

export interface ClipContext {
  segment: Segment;
  material: Material;
  trackType: TrackType;
}

/**
 * One entry in the side rail. A new feature is a new page here, or a new group
 * in an existing page, so the panel keeps its shape as the editor grows.
 */
export interface PanelPage {
  id: string;
  label: string;
  icon: IconName;
  applies(context: ClipContext): boolean;
  /** Marks the rail when the clip has something set on this page. */
  isSet?(context: ClipContext): boolean;
  render(context: ClipContext): ReactNode;
}

const NONE = { value: "", label: "Nenhuma" } as const;

const TRANSITIONS: ChoiceOption<TransitionType | "">[] = [
  NONE,
  { value: "fade", label: "Dissolver" },
  { value: "dip", label: "Preto" },
  { value: "slide", label: "Deslizar" },
  { value: "push", label: "Empurrar" },
  { value: "wipe", label: "Cortina" },
  { value: "zoom", label: "Zoom" },
  { value: "spin", label: "Girar" },
  { value: "iris", label: "Íris" },
];

const EASINGS: ChoiceOption<Easing | "">[] = [
  { value: "", label: "Linear" },
  { value: "inOut", label: "Suave" },
  { value: "out", label: "Frear" },
  { value: "in", label: "Acelerar" },
  { value: "hold", label: "Salto" },
  { value: "back", label: "Passar" },
  { value: "elastic", label: "Elástico" },
  { value: "bounce", label: "Quicar" },
];

const BLEND_MODES: { value: BlendMode; label: string }[] = [
  { value: "multiply", label: "Multiplicar" },
  { value: "screen", label: "Tela" },
  { value: "overlay", label: "Sobrepor" },
  { value: "darken", label: "Escurecer" },
  { value: "lighten", label: "Clarear" },
  { value: "color-dodge", label: "Superexposição de cor" },
  { value: "color-burn", label: "Subexposição de cor" },
  { value: "hard-light", label: "Luz forte" },
  { value: "soft-light", label: "Luz suave" },
  { value: "difference", label: "Diferença" },
  { value: "exclusion", label: "Exclusão" },
];

const ENTRANCES: ChoiceOption<string>[] = [
  NONE,
  { value: "fade", label: "Aparecer" },
  { value: "rise", label: "Subir" },
  { value: "drop", label: "Descer" },
  { value: "left", label: "Esquerda" },
  { value: "right", label: "Direita" },
  { value: "zoom", label: "Zoom" },
  { value: "pop", label: "Estourar" },
];

const TYPING: ChoiceOption<string> = { value: "type", label: "Digitando" };
const DRAWING: ChoiceOption<string> = { value: "draw", label: "Desenhar" };

const EXITS: ChoiceOption<string>[] = [
  NONE,
  { value: "fade", label: "Sumir" },
  { value: "rise", label: "Subir" },
  { value: "drop", label: "Descer" },
  { value: "left", label: "Esquerda" },
  { value: "right", label: "Direita" },
  { value: "zoom", label: "Zoom" },
];

const LOOPS: ChoiceOption<string>[] = [
  NONE,
  { value: "pulse", label: "Pulsar" },
  { value: "float", label: "Flutuar" },
  { value: "shake", label: "Tremer" },
];

const MASK_SHAPES: ChoiceOption<MaskShape | "">[] = [
  { value: "", label: "Nenhuma", icon: "none" },
  { value: "linear", label: "Linear", icon: "linear" },
  { value: "rectangle", label: "Retângulo", icon: "rectangle" },
  { value: "circle", label: "Círculo", icon: "circle" },
  { value: "heart", label: "Coração", icon: "heart" },
  { value: "star", label: "Estrela", icon: "star" },
];

const SPEEDS: ChoiceOption<string>[] = [
  { value: "0.5", label: "0,5×" },
  { value: "1", label: "1×" },
  { value: "1.5", label: "1,5×" },
  { value: "2", label: "2×" },
  { value: "4", label: "4×" },
];

const ALIGNMENTS: ChoiceOption<TextMaterial["align"]>[] = [
  { value: "left", label: "Esquerda", icon: "alignLeft" },
  { value: "center", label: "Centro", icon: "alignCenter" },
  { value: "right", label: "Direita", icon: "alignRight" },
];

const BACKGROUNDS: ChoiceOption<CanvasBackground["kind"] | "">[] = [
  { value: "", label: "Preto" },
  { value: "color", label: "Cor" },
  { value: "blur", label: "Desfoque" },
  { value: "image", label: "Imagem" },
];

const CROP_EDGES: { edge: keyof Crop; label: string }[] = [
  { edge: "left", label: "Esquerda" },
  { edge: "right", label: "Direita" },
  { edge: "top", label: "Cima" },
  { edge: "bottom", label: "Baixo" },
];

const PROP_FIELDS: { prop: AnimatableProp; label: string; min: number; max: number; step: number }[] = [
  { prop: "x", label: "Posição X", min: -2, max: 2, step: 0.01 },
  { prop: "y", label: "Posição Y", min: -2, max: 2, step: 0.01 },
  { prop: "scale", label: "Escala", min: 0.05, max: 5, step: 0.01 },
  { prop: "rotation", label: "Rotação", min: -180, max: 180, step: 1 },
  { prop: "opacity", label: "Opacidade", min: 0, max: 1, step: 0.01 },
];

const FONTS = ["Arial", "Georgia", "Impact", "Verdana", "Courier New", "Trebuchet MS"];

const DEFAULT_TRANSITION_SECONDS = 0.5;
const DEFAULT_ANIMATION_SECONDS = 0.5;
const DEFAULT_LOOP_SECONDS = 1;
const DEFAULT_SHADOW = { color: "#000000", blur: 8, distance: 6, angle: 45 };
const DEFAULT_BLUR = 40;
const DEFAULT_DENOISE = 0.6;
const DEFAULT_MASK: Omit<Mask, "shape"> = {
  x: 0,
  y: 0,
  width: 0.6,
  height: 0.6,
  rotation: 0,
  feather: 0,
  invert: false,
};

function flip(segment: Segment, axis: "flipX" | "flipY"): void {
  edit((project) =>
    updateSegment(project, segment.id, (item) => {
      item[axis] = !item[axis];
    }),
  );
}

/** Where the cursor is inside the selected clip, kept live so animated values follow it. */
function useClipOffset(): number {
  useEditor((current) => current.playhead);
  return selectedOffset();
}

/** Adds or removes a keyframe of one property at the cursor. */
function KeyDiamond({ segment, prop, label, offset }: { segment: Segment; prop: KeyedProp; label: string; offset: number }) {
  const keyframes = segment.keyframes[prop];
  const onKeyframe = keyframes?.some((keyframe) => keyframe.offset === offset);
  return (
    <button
      type="button"
      className={`keyframe${keyframes?.length ? " is-animated" : ""}${onKeyframe ? " is-on" : ""}`}
      title={onKeyframe ? "Remover keyframe" : "Adicionar keyframe no cursor"}
      aria-label={`Keyframe de ${label}`}
      aria-pressed={Boolean(onKeyframe)}
      onClick={(event) => {
        event.preventDefault();
        edit((project) => toggleKeyframe(project, segment.id, prop, offset));
      }}
    />
  );
}

const FITS: ChoiceOption<Fit>[] = [
  { value: "contain", label: "Inteiro" },
  { value: "cover", label: "Preencher" },
];

function PositionPage({ segment, material }: { segment: Segment; material: Material }) {
  const offset = useClipOffset();
  const fits = material.kind === "video" || material.kind === "image";
  return (
    <>
      {fits ? (
        <Group>
          <Choice
            label="Enquadrar na tela"
            testId="fit"
            columns={2}
            value={segment.fit ?? "contain"}
            options={FITS}
            onChange={(fit) =>
              edit((project) =>
                updateSegment(project, segment.id, (item) => {
                  if (fit === "cover") item.fit = "cover";
                  else delete item.fit;
                }),
              )
            }
          />
        </Group>
      ) : null}
      <Group>
        {PROP_FIELDS.map(({ prop, label, min, max, step }) => (
          <Field
            key={prop}
            label={label}
            min={min}
            max={max}
            step={step}
            value={sampleProp(segment, prop, offset)}
            onChange={(value) =>
              edit((project) => setProp(project, segment.id, prop, value, offset), `prop:${segment.id}:${prop}`)
            }
            trailing={<KeyDiamond segment={segment} prop={prop} label={label} offset={offset} />}
          />
        ))}
      </Group>
      <Group>
        <div className="button-row">
          <button type="button" aria-pressed={Boolean(segment.flipX)} data-testid="flip-x" onClick={() => flip(segment, "flipX")}>
            Espelhar
          </button>
          <button type="button" aria-pressed={Boolean(segment.flipY)} onClick={() => flip(segment, "flipY")}>
            Virar
          </button>
          <button
            type="button"
            title="Girar 90° no sentido anti-horário"
            aria-label="Girar 90° no sentido anti-horário"
            onClick={() => edit((project) => rotateQuarter(project, segment.id, -1, offset))}
          >
            −90°
          </button>
          <button
            type="button"
            title="Girar 90° no sentido horário"
            aria-label="Girar 90° no sentido horário"
            onClick={() => edit((project) => rotateQuarter(project, segment.id, 1, offset))}
          >
            +90°
          </button>
        </div>
        <SelectField
          label="Mistura"
          testId="blend"
          value={segment.blend ?? ""}
          onChange={(value) =>
            edit((project) =>
              updateSegment(project, segment.id, (item) => {
                if (value) item.blend = value as BlendMode;
                else delete item.blend;
              }),
            )
          }
        >
          <option value="">Normal</option>
          {BLEND_MODES.map(({ value, label }) => (
            <option key={value} value={value}>{label}</option>
          ))}
        </SelectField>
      </Group>
    </>
  );
}

const HSL_OPTIONS: { value: HslColor; label: string; color: string }[] = [
  { value: "red", label: "Vermelho", color: "#e2453c" },
  { value: "orange", label: "Laranja", color: "#ee8a2e" },
  { value: "yellow", label: "Amarelo", color: "#e6cf3a" },
  { value: "green", label: "Verde", color: "#4bb35a" },
  { value: "cyan", label: "Ciano", color: "#3cc4cf" },
  { value: "blue", label: "Azul", color: "#3b6fd9" },
  { value: "purple", label: "Roxo", color: "#8a4fd0" },
  { value: "magenta", label: "Magenta", color: "#d24fb0" },
];

const NO_SHIFT: HslShift = { hue: 0, saturation: 0, lightness: 0 };

function HslSection({ segment }: { segment: Segment }) {
  const [color, setColor] = useState<HslColor>("red");
  const shift = segment.hsl?.[color] ?? NO_SHIFT;
  const field = (name: keyof HslShift, label: string) => (
    <Field
      label={label}
      min={-100}
      max={100}
      step={1}
      value={shift[name]}
      onChange={(value) =>
        edit(
          (project) =>
            updateSegment(project, segment.id, (item) => {
              item.hsl = { ...item.hsl, [color]: { ...shift, [name]: value } };
            }),
          `hsl:${segment.id}:${color}:${name}`,
        )
      }
    />
  );
  return (
    <Group>
      <div className="hsl-colors" role="radiogroup" aria-label="Cor a ajustar">
        {HSL_OPTIONS.map(({ value, label, color: swatch }) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={value === color}
            aria-label={label}
            title={label}
            className="hsl-color"
            data-testid={`hsl-${value}`}
            style={{ background: swatch }}
            onClick={() => setColor(value)}
          />
        ))}
      </div>
      {field("hue", "Matiz")}
      {field("saturation", "Saturação")}
      {field("lightness", "Luz")}
    </Group>
  );
}

const CURVE_OPTIONS: ChoiceOption<CurveChannel>[] = [
  { value: "master", label: "Geral" },
  { value: "red", label: "Verm." },
  { value: "green", label: "Verde" },
  { value: "blue", label: "Azul" },
];

function CurvesSection({ segment }: { segment: Segment }) {
  const [channel, setChannel] = useState<CurveChannel>("master");
  return (
    <Group>
      <Choice<CurveChannel> label="Canal" testId="curve-channel" value={channel} options={CURVE_OPTIONS} onChange={setChannel} />
      <CurveEditor
        points={segment.curves?.[channel]}
        channel={channel}
        onChange={(points, key) =>
          edit(
            (project) =>
              updateSegment(project, segment.id, (item) => {
                item.curves = { ...item.curves, [channel]: points };
              }),
            key && `curve:${segment.id}:${channel}`,
          )
        }
      />
    </Group>
  );
}

const BASIC_ADJUSTMENTS: (keyof Adjust)[] = ["exposure", "brightness", "contrast", "saturation"];
const LIGHT_ADJUSTMENTS: (keyof Adjust)[] = ["temperature", "tint", "hue", "highlights", "shadows"];
const DETAIL_ADJUSTMENTS: (keyof Adjust)[] = ["sharpen", "vignette", "grain", "fade"];

function GpuNotice() {
  if (gpuAvailable()) return null;
  return <p className="panel-hint">Este navegador não tem WebGL2, então estes ajustes não aparecem no vídeo.</p>;
}

function LutSection({ segment }: { segment: Segment }) {
  const luts = useEditor((current) => current.project.luts);
  const input = useRef<HTMLInputElement>(null);
  const options: ChoiceOption<string>[] = [
    { value: "", label: "Nenhum" },
    ...Object.values(luts ?? {}).map(({ id, name }) => ({ value: id, label: name })),
  ];
  const write = (next: Segment["lut"], key?: string) =>
    edit(
      (project) =>
        updateSegment(project, segment.id, (item) => {
          if (next) item.lut = next;
          else delete item.lut;
        }),
      key,
    );
  return (
    <Group>
      <Choice
        label="LUT do clipe"
        testId="lut"
        columns={2}
        value={segment.lut?.id ?? ""}
        options={options}
        onChange={(id) => write(id ? { id, strength: segment.lut?.strength ?? 1 } : undefined)}
      />
      {segment.lut ? (
        <Field
          label="Intensidade"
          min={0}
          max={100}
          step={1}
          value={Math.round(segment.lut.strength * 100)}
          onChange={(value) => write({ ...segment.lut!, strength: value / 100 }, `lut:${segment.id}`)}
        />
      ) : null}
      <button type="button" onClick={() => input.current?.click()}>Importar LUT (.cube)</button>
      <input
        ref={input}
        type="file"
        accept=".cube"
        hidden
        data-testid="lut-input"
        onChange={(event) => {
          const files = [...(event.target.files ?? [])];
          event.target.value = "";
          void importFiles(files);
        }}
      />
    </Group>
  );
}

function ColorPage({ segment }: { segment: Segment }) {
  const offset = useClipOffset();
  const field = (name: keyof Adjust, label: string, min = -100) => (
    <Field
      label={label}
      min={min}
      max={100}
      step={1}
      value={sampleProp(segment, name, offset)}
      onChange={(value) =>
        edit((project) => setProp(project, segment.id, name, value, offset), `adjust:${segment.id}:${name}`)
      }
      trailing={<KeyDiamond segment={segment} prop={name} label={label} offset={offset} />}
    />
  );
  const anySet = (names: (keyof Adjust)[]) =>
    names.some((name) => Boolean(segment.adjust[name] || segment.keyframes[name]?.length));
  return (
    <>
      <GpuNotice />
      <Sections
        pageId="color"
        items={[
          {
            id: "basic",
            label: "Básico",
            isSet: anySet(BASIC_ADJUSTMENTS),
            render: () => (
              <Group>
                {field("exposure", "Exposição")}
                {field("brightness", "Brilho")}
                {field("contrast", "Contraste")}
                {field("saturation", "Saturação")}
              </Group>
            ),
          },
          {
            id: "light",
            label: "Luz",
            isSet: anySet(LIGHT_ADJUSTMENTS),
            render: () => (
              <Group>
                {field("temperature", "Temperatura")}
                {field("tint", "Tonalidade")}
                {field("hue", "Matiz")}
                {field("highlights", "Realces")}
                {field("shadows", "Sombras")}
              </Group>
            ),
          },
          {
            id: "detail",
            label: "Detalhe",
            isSet: anySet(DETAIL_ADJUSTMENTS),
            render: () => (
              <Group>
                {field("sharpen", "Nitidez", 0)}
                {field("vignette", "Vinheta")}
                {field("grain", "Granulado", 0)}
                {field("fade", "Desbotar", 0)}
              </Group>
            ),
          },
          { id: "hsl", label: "HSL", isSet: hasHsl(segment.hsl), render: () => <HslSection segment={segment} /> },
          { id: "curves", label: "Curvas", isSet: hasCurves(segment.curves), render: () => <CurvesSection segment={segment} /> },
          { id: "lut", label: "LUT", isSet: Boolean(segment.lut), render: () => <LutSection segment={segment} /> },
        ]}
      />
    </>
  );
}

function CropPage({ segment, canSplit }: { segment: Segment; canSplit: boolean }) {
  const busy = useEditor((current) => current.task !== null);
  return (
    <>
    <Group title="Quanto cortar de cada lado (%)">
      {CROP_EDGES.map(({ edge, label }) => (
        <Field
          key={edge}
          label={label}
          min={0}
          max={95}
          step={1}
          value={Math.round((segment.crop?.[edge] ?? 0) * 100)}
          onChange={(value) =>
            edit((project) => setCropEdge(project, segment.id, edge, value / 100), `crop:${segment.id}:${edge}`)
          }
        />
      ))}
    </Group>
    {canSplit ? (
      <Group>
        <button type="button" disabled={busy} data-testid="split-scenes" onClick={() => void splitScenes(segment.id)}>
          Dividir por cenas
        </button>
      </Group>
    ) : null}
    </>
  );
}

function MaskPage({ segment }: { segment: Segment }) {
  const { mask } = segment;
  const write = (next: Mask | undefined, key?: string) =>
    edit(
      (project) =>
        updateSegment(project, segment.id, (item) => {
          if (next) item.mask = next;
          else delete item.mask;
        }),
      key,
    );
  const number = (
    name: "x" | "y" | "width" | "height" | "rotation" | "feather",
    label: string,
    min: number,
    max: number,
    step: number,
  ) =>
    mask ? (
      <Field
        label={label}
        min={min}
        max={max}
        step={step}
        value={mask[name]}
        onChange={(value) => write({ ...mask, [name]: value }, `mask:${segment.id}:${name}`)}
      />
    ) : null;
  return (
    <>
      <Group>
        <Choice
          label="Forma da máscara"
          testId="mask-shape"
          columns={6}
          iconsOnly
          value={mask?.shape ?? ""}
          options={MASK_SHAPES}
          onChange={(shape) => write(shape ? { ...DEFAULT_MASK, ...mask, shape } : undefined)}
        />
      </Group>
      <Group>
        <Toggle
          label="Recortar o clipe de baixo"
          testId="matte"
          checked={Boolean(segment.matte)}
          onChange={(on) =>
            edit((project) =>
              updateSegment(project, segment.id, (item) => {
                if (on) item.matte = true;
                else delete item.matte;
              }),
            )
          }
        />
      </Group>
      {mask ? (
        <Group>
          {number("x", "Posição X", -1, 1, 0.01)}
          {number("y", "Posição Y", -1, 1, 0.01)}
          {mask.shape !== "linear" ? number("width", "Largura", 0.05, 2, 0.01) : null}
          {mask.shape !== "linear" ? number("height", "Altura", 0.05, 2, 0.01) : null}
          {number("rotation", "Giro", -180, 180, 1)}
          {number("feather", "Suavizar", 0, 0.5, 0.01)}
          <Toggle
            label="Inverter"
            testId="mask-invert"
            checked={mask.invert}
            onChange={(invert) => write({ ...mask, invert })}
          />
        </Group>
      ) : null}
    </>
  );
}

const DEFAULT_CHROMA: Chroma = { color: "#00ff00", strength: 0.35, softness: 0.2, spill: 0.5 };

interface EyeDropperWindow {
  EyeDropper?: new () => { open(): Promise<{ sRGBHex: string }> };
}

function ChromaSection({ segment }: { segment: Segment }) {
  const { chroma } = segment;
  const write = (next: Chroma | undefined, key?: string) =>
    edit(
      (project) =>
        updateSegment(project, segment.id, (item) => {
          if (next) item.chroma = next;
          else delete item.chroma;
        }),
      key,
    );
  const number = (name: "strength" | "softness" | "spill", label: string) =>
    chroma ? (
      <Field
        label={label}
        min={0}
        max={1}
        step={0.01}
        value={chroma[name]}
        onChange={(value) => write({ ...chroma, [name]: value }, `chroma:${segment.id}:${name}`)}
      />
    ) : null;
  const Dropper = (window as EyeDropperWindow).EyeDropper;
  return (
    <>
      <GpuNotice />
      <Group>
        <Toggle
          label="Remover cor de fundo"
          testId="chroma"
          checked={Boolean(chroma)}
          onChange={(on) => write(on ? DEFAULT_CHROMA : undefined)}
        >
          {chroma ? (
            <Swatch
              label="Cor a remover"
              testId="chroma-color"
              value={chroma.color}
              onChange={(color) => write({ ...chroma, color }, `chroma:${segment.id}:color`)}
            />
          ) : null}
        </Toggle>
        {chroma && Dropper ? (
          <button
            type="button"
            onClick={() => {
              new Dropper()
                .open()
                .then(({ sRGBHex }) => write({ ...chroma, color: sRGBHex }))
                .catch(() => undefined);
            }}
          >
            Pegar a cor no vídeo
          </button>
        ) : null}
        {number("strength", "Alcance")}
        {number("softness", "Suavizar")}
        {number("spill", "Reflexo")}
      </Group>
    </>
  );
}

const EFFECTS: { value: EffectType; label: string }[] = [
  { value: "blur", label: "Desfoque" },
  { value: "glow", label: "Brilho" },
  { value: "glitch", label: "Glitch" },
  { value: "pixelate", label: "Pixelar" },
  { value: "shake", label: "Tremor" },
  { value: "retro", label: "Retrô" },
];

const DEFAULT_EFFECT_AMOUNT = 0.5;

function EffectsPage({ segment }: { segment: Segment }) {
  const effects = segment.effects ?? {};
  const offset = useClipOffset();
  const toggle = (type: EffectType) =>
    edit((project) =>
      updateSegment(project, segment.id, (item) => {
        const next = { ...item.effects };
        if (next[type] === undefined) next[type] = DEFAULT_EFFECT_AMOUNT;
        else {
          delete next[type];
          delete item.keyframes[type];
        }
        if (Object.keys(next).length) item.effects = next;
        else delete item.effects;
      }),
    );
  return (
    <>
      <GpuNotice />
      <Group title="Combine quantos quiser">
        <div className="choice" style={{ gridTemplateColumns: "repeat(3, minmax(0, 1fr))" }}>
          {EFFECTS.map(({ value, label }) => (
            <button
              key={value}
              type="button"
              className="choice-item"
              aria-pressed={effects[value] !== undefined}
              data-testid={`effect-${value}`}
              onClick={() => toggle(value)}
            >
              {label}
            </button>
          ))}
        </div>
      </Group>
      {Object.keys(effects).length ? (
        <Group>
          {EFFECTS.filter(({ value }) => effects[value] !== undefined).map(({ value, label }) => (
            <Field
              key={value}
              label={label}
              min={0}
              max={1}
              step={0.01}
              value={sampleProp(segment, value, offset)}
              onChange={(amount) =>
                edit((project) => setProp(project, segment.id, value, amount, offset), `effect:${segment.id}:${value}`)
              }
              trailing={<KeyDiamond segment={segment} prop={value} label={label} offset={offset} />}
            />
          ))}
        </Group>
      ) : null}
    </>
  );
}

const DEFAULT_FRAME: ClipFrame = {
  radius: 0.06,
  strokeColor: "#ffffff",
  strokeWidth: 0,
  shadowColor: "",
  shadowSize: 0.08,
};

function FrameSection({ segment }: { segment: Segment }) {
  const frame = segment.frame ?? DEFAULT_FRAME;
  const write = (next: ClipFrame | undefined, key?: string) =>
    edit(
      (project) =>
        updateSegment(project, segment.id, (item) => {
          if (next) item.frame = next;
          else delete item.frame;
        }),
      key,
    );
  return (
    <>
      <Group>
        <Toggle label="Moldura" testId="frame" checked={Boolean(segment.frame)} onChange={(on) => write(on ? DEFAULT_FRAME : undefined)} />
        {segment.frame ? (
          <Field
            label="Cantos"
            min={0}
            max={0.5}
            step={0.01}
            value={frame.radius}
            onChange={(radius) => write({ ...frame, radius }, `frame:${segment.id}:radius`)}
          />
        ) : null}
      </Group>
      {segment.frame ? (
        <>
          <Group>
            <Toggle
              label="Contorno"
              testId="frame-stroke"
              checked={frame.strokeWidth > 0}
              onChange={(on) => write({ ...frame, strokeWidth: on ? 0.015 : 0 })}
            >
              {frame.strokeWidth > 0 ? (
                <Swatch label="Cor do contorno" value={frame.strokeColor} onChange={(strokeColor) => write({ ...frame, strokeColor }, `frame:${segment.id}:color`)} />
              ) : null}
            </Toggle>
            {frame.strokeWidth > 0 ? (
              <Field
                label="Espessura"
                min={0.002}
                max={0.1}
                step={0.001}
                value={frame.strokeWidth}
                onChange={(strokeWidth) => write({ ...frame, strokeWidth }, `frame:${segment.id}:stroke`)}
              />
            ) : null}
          </Group>
          <Group>
            <Toggle
              label="Sombra"
              testId="frame-shadow"
              checked={Boolean(frame.shadowColor)}
              onChange={(on) => write({ ...frame, shadowColor: on ? "#000000" : "" })}
            >
              {frame.shadowColor ? (
                <Swatch label="Cor da sombra" value={frame.shadowColor} onChange={(shadowColor) => write({ ...frame, shadowColor }, `frame:${segment.id}:shadow`)} />
              ) : null}
            </Toggle>
            {frame.shadowColor ? (
              <Field
                label="Tamanho"
                min={0.01}
                max={0.3}
                step={0.01}
                value={frame.shadowSize}
                onChange={(shadowSize) => write({ ...frame, shadowSize }, `frame:${segment.id}:size`)}
              />
            ) : null}
          </Group>
        </>
      ) : null}
    </>
  );
}

function CutPage({ segment, canSplit }: { segment: Segment; canSplit: boolean }) {
  return (
    <Sections
      pageId="cut"
      items={[
        { id: "crop", label: "Cortar", isSet: Boolean(segment.crop), render: () => <CropPage segment={segment} canSplit={canSplit} /> },
        { id: "mask", label: "Máscara", isSet: Boolean(segment.mask || segment.matte), render: () => <MaskPage segment={segment} /> },
        { id: "chroma", label: "Chroma", isSet: Boolean(segment.chroma), render: () => <ChromaSection segment={segment} /> },
        { id: "frame", label: "Moldura", isSet: Boolean(segment.frame), render: () => <FrameSection segment={segment} /> },
      ]}
    />
  );
}

type AnimationSlot = "animIn" | "animOut" | "animLoop";

function AnimationGroup({
  segment,
  slot,
  title,
  options,
  defaultSeconds,
}: {
  segment: Segment;
  slot: AnimationSlot;
  title: string;
  options: ChoiceOption<string>[];
  defaultSeconds: number;
}) {
  const current = segment[slot] as ClipAnimation<string> | undefined;
  const write = (next: ClipAnimation<string> | undefined, key?: string) =>
    edit(
      (project) =>
        updateSegment(project, segment.id, (item) => {
          if (next) Object.assign(item, { [slot]: next });
          else delete item[slot];
        }),
      key,
    );
  return (
    <Group title={title}>
      <Choice
        label={title}
        testId={slot}
        value={current?.type ?? ""}
        options={options}
        onChange={(type) =>
          write(type ? { type, duration: current?.duration ?? defaultSeconds * SECOND } : undefined)
        }
      />
      {current ? (
        <Field
          label="Duração (s)"
          min={0.1}
          max={5}
          step={0.05}
          value={current.duration / SECOND}
          onChange={(value) =>
            write({ ...current, duration: Math.round(value * SECOND) }, `${slot}:${segment.id}`)
          }
        />
      ) : null}
    </Group>
  );
}

function MotionSection({ segment }: { segment: Segment }) {
  const animated = Object.values(segment.keyframes).filter((keyframes) => keyframes?.length);
  const [onlyHere, setOnlyHere] = useState(false);
  const offset = useClipOffset();
  const here = animated.flat().find((keyframe) => keyframe.offset === offset);
  const single = onlyHere && here !== undefined;
  return (
    <>
      <Group title="Movimento de câmera">
        <div className="choice" style={{ gridTemplateColumns: "repeat(4, minmax(0, 1fr))" }}>
          {MOTION_PRESETS.map(({ value, label }) => (
            <button
              key={value}
              type="button"
              className="choice-item"
              data-testid={`motion-${value}`}
              onClick={() => edit((project) => applyMotion(project, segment.id, value))}
            >
              {label}
            </button>
          ))}
        </div>
        {hasMoveKeys(segment) ? (
          <button type="button" data-testid="motion-clear" onClick={() => edit((project) => applyMotion(project, segment.id, null))}>
            Remover movimento
          </button>
        ) : null}
      </Group>
      {animated.length ? (
        <Group title="Curva entre keyframes">
          <Choice
            label="Suavização"
            testId="easing"
            value={(single ? here : animated[0]![0]!).ease ?? ""}
            options={EASINGS}
            onChange={(value) => edit((project) => setEasing(project, segment.id, value || null, single ? offset : undefined))}
          />
          {here ? (
            <Toggle label="Só o keyframe do cursor" testId="easing-single" checked={onlyHere} onChange={setOnlyHere} />
          ) : null}
        </Group>
      ) : null}
    </>
  );
}

function ClipAnimations({ segment, kind }: { segment: Segment; kind: Material["kind"] }) {
  const extra = kind === "text" ? [TYPING] : kind === "shape" ? [DRAWING] : [];
  return (
    <>
      <AnimationGroup
        segment={segment}
        slot="animIn"
        title="Entrada"
        options={[...ENTRANCES, ...extra]}
        defaultSeconds={DEFAULT_ANIMATION_SECONDS}
      />
      <AnimationGroup
        segment={segment}
        slot="animOut"
        title="Saída"
        options={EXITS}
        defaultSeconds={DEFAULT_ANIMATION_SECONDS}
      />
      <AnimationGroup
        segment={segment}
        slot="animLoop"
        title="Loop"
        options={LOOPS}
        defaultSeconds={DEFAULT_LOOP_SECONDS}
      />
    </>
  );
}

const LETTER_TYPES: ChoiceOption<LetterAnimationType | "">[] = [
  NONE,
  { value: "fade", label: "Aparecer" },
  { value: "rise", label: "Subir" },
  { value: "drop", label: "Cair" },
  { value: "slide", label: "Deslizar" },
  { value: "pop", label: "Estourar" },
  { value: "spin", label: "Girar" },
  { value: "wave", label: "Onda" },
];

const LETTER_ORDER_OPTIONS: ChoiceOption<LetterOrder>[] = [
  { value: "forward", label: "Início" },
  { value: "reverse", label: "Fim" },
  { value: "center", label: "Centro" },
  { value: "random", label: "Sorteado" },
];

const DEFAULT_LETTERS: Omit<LetterAnimation, "type"> = { order: "forward", duration: 500_000, stagger: 50_000 };

function LettersSection({ segment }: { segment: Segment }) {
  const { letters } = segment;
  const write = (next: LetterAnimation | undefined, key?: string) =>
    edit(
      (project) =>
        updateSegment(project, segment.id, (item) => {
          if (next) item.letters = next;
          else delete item.letters;
        }),
      key,
    );
  return (
    <>
      <Group title="Animação das letras">
        <Choice
          label="Animação das letras"
          testId="letters"
          value={letters?.type ?? ""}
          options={LETTER_TYPES}
          onChange={(type) => write(type ? { ...DEFAULT_LETTERS, ...letters, type } : undefined)}
        />
      </Group>
      {letters ? (
        <Group title="Começar por">
          <Choice
            label="Ordem das letras"
            testId="letter-order"
            value={letters.order}
            options={LETTER_ORDER_OPTIONS}
            onChange={(order) => write({ ...letters, order })}
          />
          <Field
            label="Cada letra (s)"
            min={0.05}
            max={2}
            step={0.05}
            value={letters.duration / SECOND}
            onChange={(value) => write({ ...letters, duration: Math.round(value * SECOND) }, `letters:${segment.id}:duration`)}
          />
          <Field
            label="Intervalo (s)"
            min={0.01}
            max={0.5}
            step={0.01}
            value={letters.stagger / SECOND}
            onChange={(value) => write({ ...letters, stagger: Math.round(value * SECOND) }, `letters:${segment.id}:stagger`)}
          />
        </Group>
      ) : null}
    </>
  );
}

function AnimationPage({ segment, kind }: { segment: Segment; kind: Material["kind"] }) {
  const isText = kind === "text";
  return (
    <Sections
      pageId="animate"
      items={[
        ...(isText
          ? [{ id: "letters", label: "Letras", isSet: Boolean(segment.letters), render: () => <LettersSection segment={segment} /> }]
          : []),
        {
          id: "clip-anim",
          label: "Clipe",
          isSet: Boolean(segment.animIn || segment.animOut || segment.animLoop),
          render: () => <ClipAnimations segment={segment} kind={kind} />,
        },
        {
          id: "motion",
          label: "Movimento",
          isSet: Object.keys(segment.keyframes).length > 0,
          render: () => <MotionSection segment={segment} />,
        },
      ]}
    />
  );
}

function SpeedPage({ segment }: { segment: Segment }) {
  const apply = (value: number, key?: string) =>
    edit((project) => setSpeed(project, segment.id, Math.min(MAX_SPEED, value)), key);
  return (
    <Group>
      <Choice
        label="Velocidade pronta"
        testId="speed"
        columns={5}
        value={String(segment.speed)}
        options={SPEEDS}
        onChange={(value) => apply(Number(value))}
      />
      <Field
        label="Velocidade"
        min={MIN_SPEED}
        max={4}
        step={0.05}
        value={segment.speed}
        onChange={(value) => apply(value, `speed:${segment.id}`)}
      />
      <Toggle
        label="Inverter"
        testId="reverse"
        checked={Boolean(segment.reversed)}
        onChange={(on) =>
          edit((project) =>
            updateSegment(project, segment.id, (item) => {
              if (on) item.reversed = true;
              else delete item.reversed;
            }),
          )
        }
      />
      <Toggle
        label="Manter o tom"
        testId="keep-pitch"
        checked={!segment.changePitch}
        onChange={(keep) =>
          edit((project) =>
            updateSegment(project, segment.id, (item) => {
              if (keep) delete item.changePitch;
              else item.changePitch = true;
            }),
          )
        }
      />
    </Group>
  );
}

const NO_AUDIO_EFFECTS: AudioEffects = { low: 0, mid: 0, high: 0, compressor: false, reverb: 0 };

const SPEECH_MODELS: ChoiceOption<SpeechModel>[] = [
  { value: "fast", label: "Rápido · 73 MB" },
  { value: "accurate", label: "Preciso · 238 MB" },
];

const LANGUAGES = [
  { value: "portuguese", label: "Português" },
  { value: "english", label: "Inglês" },
  { value: "spanish", label: "Espanhol" },
  { value: "", label: "Detectar" },
];

function SpeechSection({ segment }: { segment: Segment }) {
  const [model, setModel] = useState<SpeechModel>("fast");
  const [language, setLanguage] = useState("portuguese");
  const running = useEditor((current) => current.task !== null);
  const count = segment.words?.length ?? 0;
  return (
    <>
      <Group>
        <SelectField label="Idioma" value={language} onChange={setLanguage}>
          {LANGUAGES.map(({ value, label }) => (
            <option key={value} value={value}>{label}</option>
          ))}
        </SelectField>
        <Choice<SpeechModel>
          label="Modelo"
          testId="speech-model"
          columns={2}
          value={model}
          options={SPEECH_MODELS}
          onChange={setModel}
        />
        {running ? (
          <button type="button" data-testid="speech-cancel" onClick={cancelSpeech}>Cancelar</button>
        ) : (
          <button
            type="button"
            className="primary"
            data-testid="transcribe"
            onClick={() => void transcribeClip(segment.id, model, language || null)}
          >
            {count ? "Transcrever de novo" : "Transcrever"}
          </button>
        )}
        <p className="group-note">O modelo é baixado uma vez. Sua fala não sai do computador.</p>
      </Group>
      {count ? (
        <Group title={`${count} palavras`}>
          <div className="button-row">
            <button type="button" data-testid="create-captions" onClick={() => createCaptions(segment.id)}>
              Criar legendas
            </button>
            <button type="button" data-testid="cut-hesitations" onClick={() => cutHesitations(segment.id)}>
              Cortar hesitações
            </button>
          </div>
          <p className="group-note">Para corrigir ou cortar palavras, abra a aba Fala, à esquerda.</p>
        </Group>
      ) : null}
    </>
  );
}

function AudioPage({ segment }: { segment: Segment }) {
  const busy = useEditor((current) => current.audioBusy > 0);
  const setDenoise = (value: number, key?: string) =>
    edit(
      (project) =>
        updateSegment(project, segment.id, (item) => {
          if (value) item.denoise = value;
          else delete item.denoise;
        }),
      key,
    );
  const fade = (name: "fadeIn" | "fadeOut", label: string) => (
    <Field
      label={label}
      min={0}
      max={Math.min(5, segment.target.duration / SECOND)}
      step={0.05}
      value={segment[name] / SECOND}
      onChange={(value) =>
        edit(
          (project) =>
            updateSegment(project, segment.id, (item) => {
              item[name] = Math.round(value * SECOND);
            }),
          `${name}:${segment.id}`,
        )
      }
    />
  );
  const effects = segment.audioEffects ?? NO_AUDIO_EFFECTS;
  const setEffects = (patch: Partial<AudioEffects>, key?: string) =>
    edit(
      (project) =>
        updateSegment(project, segment.id, (item) => {
          const next = { ...effects, ...patch };
          const changed = next.low || next.mid || next.high || next.compressor || next.reverb;
          if (changed) item.audioEffects = next;
          else delete item.audioEffects;
        }),
      key,
    );
  const band = (name: "low" | "mid" | "high", label: string) => (
    <Field
      label={label}
      min={-12}
      max={12}
      step={0.5}
      value={effects[name]}
      onChange={(value) => setEffects({ [name]: value }, `eq:${segment.id}:${name}`)}
    />
  );
  const shaping = (
    <>
      <Group title="Equalizador (dB)">
        {band("low", "Graves")}
        {band("mid", "Médios")}
        {band("high", "Agudos")}
      </Group>
      <Group>
        <Toggle
          label="Compressor"
          testId="compressor"
          checked={effects.compressor}
          onChange={(compressor) => setEffects({ compressor })}
        />
        <Field
          label="Reverb"
          min={0}
          max={1}
          step={0.01}
          value={effects.reverb}
          onChange={(reverb) => setEffects({ reverb }, `reverb:${segment.id}`)}
        />
      </Group>
    </>
  );
  const sound = (
    <>
    <Group>
      <Field
        label="Volume"
        min={0}
        max={MAX_VOLUME}
        step={0.01}
        value={segment.volume}
        onChange={(value) =>
          edit(
            (project) =>
              updateSegment(project, segment.id, (item) => {
                item.volume = value;
              }),
            `volume:${segment.id}`,
          )
        }
      />
      <Field
        label="Balanço"
        min={-1}
        max={1}
        step={0.01}
        value={segment.pan ?? 0}
        onChange={(value) =>
          edit(
            (project) =>
              updateSegment(project, segment.id, (item) => {
                if (value) item.pan = value;
                else delete item.pan;
              }),
            `pan:${segment.id}`,
          )
        }
      />
      {fade("fadeIn", "Fade in (s)")}
      {fade("fadeOut", "Fade out (s)")}
    </Group>
    <Group>
      <Toggle
        label="Reduzir ruído"
        testId="denoise"
        checked={Boolean(segment.denoise)}
        onChange={(on) => setDenoise(on ? DEFAULT_DENOISE : 0)}
      />
      {segment.denoise ? (
        <Field
          label="Intensidade"
          min={0.1}
          max={1}
          step={0.05}
          value={segment.denoise}
          onChange={(value) => setDenoise(value, `denoise:${segment.id}`)}
        />
      ) : null}
    </Group>
    </>
  );
  const automatic = (
    <Group>
      <div className="button-row">
        <button
          type="button"
          disabled={busy}
          title="Ajusta o volume deste clipe para -14 LUFS"
          data-testid="normalize-clip"
          onClick={() => void normalizeClips([segment.id])}
        >
          Normalizar
        </button>
        <button
          type="button"
          disabled={busy}
          title="Deixa todos os clipes com o mesmo volume percebido"
          data-testid="normalize-all"
          onClick={() => void normalizeClips(audibleClips())}
        >
          Normalizar todos
        </button>
      </div>
      <div className="button-row">
        <button type="button" disabled={busy} data-testid="mark-beats" onClick={() => void markBeats(segment.id)}>
          Marcar batidas
        </button>
        {segment.beats ? (
          <button
            type="button"
            data-testid="clear-beats"
            onClick={() =>
              edit((project) =>
                updateSegment(project, segment.id, (item) => {
                  delete item.beats;
                }),
              )
            }
          >
            Limpar
          </button>
        ) : null}
      </div>
      {segment.beats ? (
        <div className="button-row">
          <button type="button" data-testid="cut-to-beats" onClick={() => cutVideoToBeats(segment.id)}>
            Cortar vídeo no ritmo
          </button>
        </div>
      ) : null}
      <div className="button-row">
        <button
          type="button"
          disabled={busy}
          title="Abaixa este clipe nos trechos em que outro clipe tem fala"
          data-testid="duck"
          onClick={() => void duckUnderSpeech(segment.id)}
        >
          Abaixar sob a fala
        </button>
        {segment.ducking ? (
          <button
            type="button"
            data-testid="duck-clear"
            onClick={() =>
              edit((project) =>
                updateSegment(project, segment.id, (item) => {
                  delete item.ducking;
                }),
              )
            }
          >
            Desfazer
          </button>
        ) : null}
      </div>
      <div className="button-row">
        <button
          type="button"
          disabled={busy}
          title="Remove os silêncios de meio segundo ou mais, mantendo legendas em sincronia"
          data-testid="cut-pauses"
          onClick={() => void cutPauses(segment.id)}
        >
          Cortar pausas
        </button>
      </div>
    </Group>
  );
  return (
    <Sections
      pageId="audio"
      items={[
        {
          id: "sound",
          label: "Som",
          isSet:
            segment.volume !== 1 ||
            segment.fadeIn > 0 ||
            segment.fadeOut > 0 ||
            Boolean(segment.pan || segment.denoise),
          render: () => sound,
        },
        { id: "shaping", label: "Efeitos", isSet: Boolean(segment.audioEffects), render: () => shaping },
        { id: "auto", label: "Automático", isSet: Boolean(segment.beats || segment.ducking), render: () => automatic },
        { id: "speech", label: "Fala", isSet: Boolean(segment.words?.length), render: () => <SpeechSection segment={segment} /> },
      ]}
    />
  );
}

function TransitionPage({ segment }: { segment: Segment }) {
  const project = useEditor((current) => current.project);
  const current = segment.transitionOut;
  if (!adjacentNext(project, segment.id)) {
    return <p className="panel-hint">Encoste outro clipe logo depois deste para usar uma transição.</p>;
  }
  return (
    <Group title="Para o próximo clipe">
      <Choice
        label="Tipo de transição"
        testId="transition"
        columns={3}
        value={current?.type ?? ""}
        options={TRANSITIONS}
        onChange={(type) =>
          edit((value) =>
            setTransition(
              value,
              segment.id,
              type ? { type, duration: current?.duration ?? DEFAULT_TRANSITION_SECONDS * SECOND } : null,
            ),
          )
        }
      />
      {current ? (
        <Field
          label="Duração (s)"
          min={0.1}
          max={3}
          step={0.05}
          value={current.duration / SECOND}
          onChange={(value) =>
            edit(
              (next) =>
                setTransition(next, segment.id, { ...current, duration: Math.round(value * SECOND) }),
              `transition:${segment.id}`,
            )
          }
        />
      ) : null}
    </Group>
  );
}

function presetLook({ style }: TextPreset): CSSProperties {
  const { shadow } = style;
  return {
    color: style.color ?? "#ffffff",
    background: style.background || undefined,
    fontFamily: style.fontFamily ?? "Arial",
    fontWeight: style.bold === false ? 400 : 700,
    fontStyle: style.italic ? "italic" : undefined,
    // Painted behind the fill, otherwise a stroke eats the small letters of a tile.
    WebkitTextStroke: style.strokeWidth ? `2px ${style.strokeColor ?? "#000000"}` : undefined,
    paintOrder: "stroke fill",
    textShadow: shadow ? `1px 1px ${Math.min(shadow.blur, 8)}px ${shadow.color}` : undefined,
  };
}

function PresetsPage({ segment, material }: { segment: Segment; material: TextMaterial }) {
  const [saved, setSaved] = useState(loadUserPresets);
  const update = (next: TextPreset[]) => {
    setSaved(next);
    storeUserPresets(next);
  };
  const tile = (preset: TextPreset, onRemove?: () => void) => (
    <button
      key={preset.id}
      type="button"
      className="preset"
      style={presetLook(preset)}
      title={onRemove ? "Aplicar. Botão direito para remover." : "Aplicar este modelo"}
      data-testid={`preset-${preset.id}`}
      onClick={() => edit((project) => applyTextPreset(project, segment.id, preset))}
      onContextMenu={(event) => {
        if (!onRemove) return;
        event.preventDefault();
        onRemove();
      }}
    >
      {preset.label}
    </button>
  );
  return (
    <>
      <Group>
        <div className="preset-grid">{TEXT_PRESETS.map((preset) => tile(preset))}</div>
      </Group>
      <Group title="Meus estilos">
        {saved.length ? (
          <div className="preset-grid">
            {saved.map((preset) => tile(preset, () => update(saved.filter((item) => item.id !== preset.id))))}
          </div>
        ) : null}
        <button
          type="button"
          data-testid="preset-save"
          onClick={() => update([...saved, presetFrom(material, segment, newId(), `Meu estilo ${saved.length + 1}`)])}
        >
          Salvar este estilo
        </button>
      </Group>
    </>
  );
}

function useTextPatch(material: TextMaterial) {
  return (value: Partial<TextMaterial>, key: string) =>
    edit((project) => updateMaterial(project, material.id, value), `text:${material.id}:${key}`);
}

function TextPage({ material }: { material: TextMaterial }) {
  const patch = useTextPatch(material);
  const fonts = useEditor((current) => current.project.fonts);
  return (
    <>
      <Group>
        <textarea
          aria-label="Conteúdo do texto"
          data-testid="text-content"
          rows={2}
          value={material.text}
          onChange={(event) => patch({ text: event.target.value }, "text")}
        />
        <SelectField label="Fonte" value={material.fontFamily} onChange={(fontFamily) => patch({ fontFamily }, "font")}>
          {[...new Set([material.fontFamily, ...Object.values(fonts ?? {}).map(({ name }) => name), ...FONTS])].map((font) => (
            <option key={font} value={font}>{font}</option>
          ))}
        </SelectField>
        <Field
          label="Tamanho"
          min={12}
          max={300}
          step={1}
          value={material.fontSize}
          onChange={(value) => patch({ fontSize: value }, "size")}
        />
        <div className="button-row">
          <Swatch label="Cor do texto" value={material.color} onChange={(color) => patch({ color }, "color")} />
          <button type="button" aria-pressed={material.bold} onClick={() => patch({ bold: !material.bold }, "bold")}>
            Negrito
          </button>
          <button type="button" aria-pressed={material.italic} onClick={() => patch({ italic: !material.italic }, "italic")}>
            Itálico
          </button>
        </div>
      </Group>
      <Group>
        <Choice
          label="Alinhamento"
          testId="text-align"
          columns={3}
          value={material.align}
          options={ALIGNMENTS}
          onChange={(align) => patch({ align }, "align")}
        />
        <Field
          label="Letras"
          min={-10}
          max={60}
          step={1}
          value={material.letterSpacing ?? 0}
          onChange={(value) => patch({ letterSpacing: value }, "letterSpacing")}
        />
        <Field
          label="Linhas"
          min={0.8}
          max={3}
          step={0.05}
          value={material.lineHeight ?? 1.25}
          onChange={(value) => patch({ lineHeight: value }, "lineHeight")}
        />
        <Field
          label="Curvatura"
          min={-180}
          max={180}
          step={1}
          value={material.curve ?? 0}
          onChange={(value) => patch({ curve: value }, "curve")}
        />
      </Group>
    </>
  );
}

const SPOKEN_MODES: ChoiceOption<"" | "highlight" | "single">[] = [
  { value: "", label: "Normal" },
  { value: "highlight", label: "Destacar" },
  { value: "single", label: "Uma por vez" },
];

const DEFAULT_SPOKEN_COLOR = "#ffd400";
const DEFAULT_SPOKEN_BOX = "#7c3aed";

function CaptionSection({ segment, material }: { segment: Segment; material: TextMaterial }) {
  const { spoken } = material;
  const write = (next: TextMaterial["spoken"], key?: string) =>
    edit((project) => setSpokenStyle(project, next), key);
  return (
    <>
      <Group title="Palavra falada, em todas as legendas">
        <Choice
          label="Palavra falada"
          testId="spoken"
          columns={3}
          value={spoken?.mode ?? ""}
          options={SPOKEN_MODES}
          onChange={(mode) => write(mode ? { mode, color: spoken?.color ?? DEFAULT_SPOKEN_COLOR } : undefined)}
        />
        {spoken ? (
          <>
            <div className="button-row">
              <Swatch
                label="Cor da palavra falada"
                testId="spoken-color"
                value={spoken.color}
                onChange={(color) => write({ ...spoken, color }, "spoken-color")}
              />
            </div>
            <Field
              label="Tamanho"
              min={100}
              max={Math.round(MAX_SPOKEN_SCALE * 100)}
              step={5}
              value={Math.round((spoken.scale ?? 1) * 100)}
              onChange={(value) => write({ ...spoken, scale: value / 100 }, "spoken-scale")}
            />
            <Toggle
              label="Caixa atrás da palavra"
              testId="spoken-box"
              checked={Boolean(spoken.box)}
              onChange={(on) => write({ ...spoken, box: on ? DEFAULT_SPOKEN_BOX : "" })}
            >
              {spoken.box ? (
                <Swatch
                  label="Cor da caixa"
                  value={spoken.box}
                  onChange={(box) => write({ ...spoken, box }, "spoken-box")}
                />
              ) : null}
            </Toggle>
          </>
        ) : null}
      </Group>
      <Group>
        <button
          type="button"
          data-testid="match-captions"
          title="Copia aparência, posição e animação deste texto para os outros desta faixa"
          onClick={() => edit((project) => matchTrackStyle(project, segment.id))}
        >
          Aplicar este visual a toda a faixa
        </button>
      </Group>
    </>
  );
}

function TextStyleSections({ segment, material }: { segment: Segment; material: TextMaterial }) {
  if (!material.timing) {
    return (
      <>
        <TextStylePage material={material} />
        <Group>
          <button type="button" data-testid="match-captions" onClick={() => edit((project) => matchTrackStyle(project, segment.id))}>
            Aplicar este visual a toda a faixa
          </button>
        </Group>
      </>
    );
  }
  return (
    <Sections
      pageId="style"
      items={[
        { id: "look", label: "Aparência", render: () => <TextStylePage material={material} /> },
        {
          id: "caption",
          label: "Legenda",
          isSet: Boolean(material.spoken),
          render: () => <CaptionSection segment={segment} material={material} />,
        },
      ]}
    />
  );
}

function TextStylePage({ material }: { material: TextMaterial }) {
  const patch = useTextPatch(material);
  const { shadow } = material;
  return (
    <>
      <Group>
        <Toggle
          label="Contorno"
          checked={material.strokeWidth > 0}
          onChange={(on) => patch({ strokeWidth: on ? 4 : 0 }, "strokeWidth")}
        >
          {material.strokeWidth > 0 ? (
            <Swatch
              label="Cor do contorno"
              value={material.strokeColor}
              onChange={(strokeColor) => patch({ strokeColor }, "stroke")}
            />
          ) : null}
        </Toggle>
        {material.strokeWidth > 0 ? (
          <Field
            label="Espessura"
            min={1}
            max={20}
            step={1}
            value={material.strokeWidth}
            onChange={(value) => patch({ strokeWidth: value }, "strokeWidth")}
          />
        ) : null}
      </Group>
      <Group>
        <Toggle
          label="Fundo"
          checked={Boolean(material.background)}
          onChange={(on) => patch({ background: on ? "#000000" : "" }, "background")}
        >
          {material.background ? (
            <Swatch
              label="Cor do fundo"
              value={material.background}
              onChange={(background) => patch({ background }, "background")}
            />
          ) : null}
        </Toggle>
        {material.background ? (
          <>
            <Field
              label="Margem"
              min={0}
              max={150}
              step={5}
              value={Math.round((material.backgroundPadding ?? 0.25) * 100)}
              onChange={(value) => patch({ backgroundPadding: value / 100 }, "backgroundPadding")}
            />
            <Field
              label="Arredondar"
              min={0}
              max={100}
              step={5}
              value={Math.round((material.backgroundRadius ?? 0) * 100)}
              onChange={(value) => patch({ backgroundRadius: value / 100 }, "backgroundRadius")}
            />
          </>
        ) : null}
      </Group>
      <Group>
        <Toggle
          label="Sombra"
          testId="text-shadow"
          checked={Boolean(shadow)}
          onChange={(on) => patch({ shadow: on ? DEFAULT_SHADOW : undefined }, "shadow")}
        >
          {shadow ? (
            <Swatch
              label="Cor da sombra"
              value={shadow.color}
              onChange={(color) => patch({ shadow: { ...shadow, color } }, "shadowColor")}
            />
          ) : null}
        </Toggle>
        {shadow ? (
          <>
            <Field
              label="Desfoque"
              min={0}
              max={60}
              step={1}
              value={shadow.blur}
              onChange={(value) => patch({ shadow: { ...shadow, blur: value } }, "shadowBlur")}
            />
            <Field
              label="Distância"
              min={0}
              max={60}
              step={1}
              value={shadow.distance}
              onChange={(value) => patch({ shadow: { ...shadow, distance: value } }, "shadowDistance")}
            />
            <Field
              label="Ângulo"
              min={-180}
              max={180}
              step={1}
              value={shadow.angle}
              onChange={(value) => patch({ shadow: { ...shadow, angle: value } }, "shadowAngle")}
            />
          </>
        ) : null}
      </Group>
    </>
  );
}

export function BackgroundPage() {
  const project = useEditor((current) => current.project);
  const { background } = project;
  const images = Object.values(project.materials).filter(
    (material) => material.kind === "image" && !material.offline,
  );
  const write = (next: CanvasBackground | undefined, key?: string) =>
    edit((current) => {
      const { background: _previous, ...rest } = current;
      return next ? { ...rest, background: next } : rest;
    }, key);
  const options = images.length ? BACKGROUNDS : BACKGROUNDS.filter(({ value }) => value !== "image");
  return (
    <Group title="O que aparece onde nenhum clipe cobre a tela">
      <Choice
        label="Fundo da tela"
        testId="bg-kind"
        columns={options.length}
        value={background?.kind ?? ""}
        options={options}
        onChange={(kind) => {
          if (kind === "color") write({ kind, color: "#000000" });
          else if (kind === "blur") write({ kind, amount: DEFAULT_BLUR });
          else if (kind === "image") write({ kind, materialId: images[0]!.id });
          else write(undefined);
        }}
      />
      {background?.kind === "color" ? (
        <div className="button-row">
          <Swatch
            label="Cor do fundo da tela"
            testId="bg-color"
            value={background.color}
            onChange={(color) => write({ kind: "color", color }, "bg-color")}
          />
        </div>
      ) : null}
      {background?.kind === "blur" ? (
        <Field
          label="Desfoque"
          min={5}
          max={120}
          step={1}
          value={background.amount}
          onChange={(amount) => write({ kind: "blur", amount }, "bg-blur")}
        />
      ) : null}
      {background?.kind === "image" ? (
        <SelectField
          label="Imagem"
          value={background.materialId}
          onChange={(materialId) => write({ kind: "image", materialId })}
        >
          {images.map((image) => (
            <option key={image.id} value={image.id}>{image.kind === "image" ? image.name : ""}</option>
          ))}
        </SelectField>
      ) : null}
    </Group>
  );
}

const isVisual = ({ trackType, material }: ClipContext) => trackType !== "audio" && material.kind !== "adjustment";
const hasLook = ({ trackType, material }: ClipContext) => trackType === "video" || material.kind === "adjustment";
const isMedia = ({ trackType }: ClipContext) => trackType === "video";
const isTimed = ({ material, segment }: ClipContext) =>
  (material.kind === "video" || material.kind === "audio") && !segment.frozen;

function textOf({ material }: ClipContext): TextMaterial {
  return material as TextMaterial;
}

const SHAPE_KINDS: ChoiceOption<ShapeKind>[] = [
  { value: "rectangle", label: "Retângulo", icon: "rectangle" },
  { value: "circle", label: "Círculo", icon: "circle" },
  { value: "triangle", label: "Triângulo", icon: "triangle" },
  { value: "star", label: "Estrela", icon: "star" },
  { value: "heart", label: "Coração", icon: "heart" },
  { value: "line", label: "Linha", icon: "line" },
];

function ShapePage({ material }: { material: ShapeMaterial }) {
  const patch = (value: Partial<ShapeMaterial>, key?: string) =>
    edit((project) => updateMaterial(project, material.id, value), key && `shape:${material.id}:${key}`);
  return (
    <>
      <Group>
        <Choice
          label="Forma"
          testId="shape-kind"
          columns={6}
          iconsOnly
          value={material.shape}
          options={SHAPE_KINDS}
          onChange={(shape) => patch({ shape })}
        />
        <Field label="Largura" min={0.02} max={2} step={0.01} value={material.width} onChange={(width) => patch({ width }, "width")} />
        <Field label="Altura" min={0.01} max={2} step={0.01} value={material.height} onChange={(height) => patch({ height }, "height")} />
        {material.shape === "rectangle" ? (
          <Field label="Cantos" min={0} max={0.5} step={0.01} value={material.radius} onChange={(radius) => patch({ radius }, "radius")} />
        ) : null}
      </Group>
      {material.shape !== "line" ? (
        <Group>
          <Toggle label="Preenchimento" checked={Boolean(material.fill)} onChange={(on) => patch({ fill: on ? "#f2a33a" : "" })}>
            {material.fill ? (
              <div className="button-row">
                <Swatch label="Cor" testId="shape-fill" value={material.fill} onChange={(fill) => patch({ fill }, "fill")} />
                {material.fill2 ? (
                  <Swatch label="Segunda cor" testId="shape-fill2" value={material.fill2} onChange={(fill2) => patch({ fill2 }, "fill2")} />
                ) : null}
              </div>
            ) : null}
          </Toggle>
          {material.fill ? (
            <Toggle
              label="Gradiente"
              testId="shape-gradient"
              checked={Boolean(material.fill2)}
              onChange={(on) => patch({ fill2: on ? "#7a4f9e" : "" })}
            />
          ) : null}
          {material.fill && material.fill2 ? (
            <Field
              label="Ângulo"
              min={-180}
              max={180}
              step={1}
              value={material.gradientAngle}
              onChange={(gradientAngle) => patch({ gradientAngle }, "angle")}
            />
          ) : null}
        </Group>
      ) : null}
      <Group>
        <Toggle
          label="Contorno"
          testId="shape-stroke"
          checked={material.strokeWidth > 0}
          onChange={(on) => patch({ strokeWidth: on ? 8 : 0 })}
        >
          {material.strokeWidth > 0 ? (
            <Swatch label="Cor do contorno" value={material.stroke} onChange={(stroke) => patch({ stroke }, "stroke")} />
          ) : null}
        </Toggle>
        {material.strokeWidth > 0 ? (
          <Field
            label="Espessura"
            min={1}
            max={60}
            step={1}
            value={material.strokeWidth}
            onChange={(strokeWidth) => patch({ strokeWidth }, "strokeWidth")}
          />
        ) : null}
      </Group>
    </>
  );
}

export const CLIP_PAGES: PanelPage[] = [
  {
    id: "shape",
    label: "Forma",
    icon: "star",
    applies: ({ material }) => material.kind === "shape",
    render: ({ material }) => <ShapePage material={material as ShapeMaterial} />,
  },
  {
    id: "text",
    label: "Texto",
    icon: "text",
    applies: ({ material }) => material.kind === "text",
    render: (context) => <TextPage material={textOf(context)} />,
  },
  {
    id: "presets",
    label: "Modelos",
    icon: "presets",
    applies: ({ material }) => material.kind === "text",
    render: (context) => <PresetsPage segment={context.segment} material={textOf(context)} />,
  },
  {
    id: "style",
    label: "Estilo",
    icon: "style",
    applies: ({ material }) => material.kind === "text",
    isSet: (context) => {
      const { strokeWidth, background, shadow } = textOf(context);
      return strokeWidth > 0 || Boolean(background) || Boolean(shadow);
    },
    render: (context) => <TextStyleSections segment={context.segment} material={textOf(context)} />,
  },
  {
    id: "position",
    label: "Posição",
    icon: "position",
    applies: isVisual,
    isSet: ({ segment }) =>
      Boolean(segment.flipX || segment.flipY || segment.blend || segment.fit === "cover") || hasMoveKeys(segment),
    render: ({ segment, material }) => <PositionPage segment={segment} material={material} />,
  },
  {
    id: "cut",
    label: "Recorte",
    icon: "crop",
    applies: isMedia,
    isSet: ({ segment }) => Boolean(segment.crop || segment.mask || segment.chroma || segment.frame),
    render: ({ segment, material }) => (
      <CutPage segment={segment} canSplit={material.kind === "video" && !segment.frozen} />
    ),
  },
  {
    id: "mask",
    label: "Máscara",
    icon: "mask",
    applies: ({ material }) => !isMediaMaterial(material) && material.kind !== "adjustment",
    isSet: ({ segment }) => Boolean(segment.mask || segment.matte),
    render: ({ segment }) => <MaskPage segment={segment} />,
  },
  {
    id: "color",
    label: "Cor",
    icon: "color",
    applies: hasLook,
    isSet: ({ segment }) =>
      Object.values(segment.adjust).some(Boolean) ||
      hasAdjustKeys(segment) ||
      Boolean(segment.lut) ||
      hasHsl(segment.hsl) ||
      hasCurves(segment.curves),
    render: ({ segment }) => <ColorPage segment={segment} />,
  },
  {
    id: "effects",
    label: "Efeitos",
    icon: "effects",
    applies: hasLook,
    isSet: ({ segment }) => Object.keys(segment.effects ?? {}).length > 0,
    render: ({ segment }) => <EffectsPage segment={segment} />,
  },
  {
    id: "animate",
    label: "Animar",
    icon: "animate",
    applies: isVisual,
    isSet: ({ segment }) =>
      Boolean(segment.animIn || segment.animOut || segment.animLoop || segment.letters) ||
      Object.keys(segment.keyframes).length > 0,
    render: ({ segment, material }) => <AnimationPage segment={segment} kind={material.kind} />,
  },
  {
    id: "speed",
    label: "Velocidade",
    icon: "speed",
    applies: isTimed,
    isSet: ({ segment }) => segment.speed !== 1 || Boolean(segment.reversed),
    render: ({ segment }) => <SpeedPage segment={segment} />,
  },
  {
    id: "audio",
    label: "Áudio",
    icon: "audio",
    applies: (context) => {
      const { material } = context;
      return isTimed(context) && isMediaMaterial(material) && material.hasAudio;
    },
    isSet: ({ segment }) =>
      segment.volume !== 1 ||
      segment.fadeIn > 0 ||
      segment.fadeOut > 0 ||
      Boolean(
        segment.pan || segment.denoise || segment.beats || segment.ducking || segment.audioEffects || segment.words?.length,
      ),
    render: ({ segment }) => <AudioPage segment={segment} />,
  },
  {
    id: "transition",
    label: "Transição",
    icon: "transition",
    applies: isMedia,
    isSet: ({ segment }) => Boolean(segment.transitionOut),
    render: ({ segment }) => <TransitionPage segment={segment} />,
  },
];
