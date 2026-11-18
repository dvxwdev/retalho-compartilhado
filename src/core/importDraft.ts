import {
  DEFAULT_ADJUST,
  DEFAULT_TRANSFORM,
  createProject,
  newId,
  type AnimatableProp,
  type Keyframe,
  type Marker,
  type Material,
  type Project,
  type Segment,
  type TextMaterial,
  type Track,
  type TrackType,
} from "./model";

/**
 * Reads a CapCut draft_content.json into a Project, as far as this editor can
 * represent it. Field meanings come from inspecting drafts written by version
 * 9.1. What cannot be represented is reported in warnings, not silently dropped.
 */

// The draft is external, loosely typed JSON with dozens of optional fields.
type Json = Record<string, any>;

interface DraftEntry {
  category: string;
  item: Json;
}

export interface DraftImport {
  project: Project;
  warnings: string[];
  /** Material id to the original file name, for relinking. */
  offlineFiles: Record<string, string>;
}

const KEYFRAME_PROPS: Record<string, AnimatableProp> = {
  KFTypePositionX: "x",
  KFTypePositionY: "y",
  KFTypeScaleX: "scale",
  KFTypeRotation: "rotation",
  KFTypeAlpha: "opacity",
  KFTypeGlobalAlpha: "opacity",
};

const ADJUST_TYPES = ["brightness", "contrast", "saturation"] as const;

const MARKER_COLOR = "#2fb8c6";

/** The draft stores text size in its own unit; this factor is an approximation. */
const FONT_SIZE_FACTOR = 5;

const TRACK_LABEL: Record<TrackType, string> = { video: "Vídeo", text: "Texto", audio: "Áudio" };

export function isCapCutDraft(value: unknown): value is Json {
  const draft = value as Json | null;
  return Boolean(draft && Array.isArray(draft.tracks) && draft.materials && draft.canvas_config);
}

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

function indexMaterials(draft: Json): Map<string, DraftEntry> {
  const index = new Map<string, DraftEntry>();
  for (const [category, items] of Object.entries(draft.materials as Json)) {
    if (!Array.isArray(items)) continue;
    for (const item of items as Json[]) index.set(item.id, { category, item });
  }
  return index;
}

function toTextMaterial(item: Json): TextMaterial {
  let text: string;
  try {
    text = JSON.parse(item.content).text ?? "";
  } catch {
    text = String(item.content ?? "");
  }
  return {
    id: newId(),
    kind: "text",
    text,
    fontFamily: "Arial",
    fontSize: Math.max(8, Math.round((item.font_size ?? 15) * FONT_SIZE_FACTOR)),
    color: item.text_color || "#ffffff",
    bold: (item.bold_width ?? 0) > 0,
    italic: false,
    align: item.alignment === 0 ? "left" : item.alignment === 2 ? "right" : "center",
    strokeColor: item.border_color || "#000000",
    strokeWidth: item.border_color ? Math.round((item.border_width ?? 0) * 40) : 0,
    background: "",
  };
}

function keyframesOf(segment: Json): Segment["keyframes"] {
  const result: Segment["keyframes"] = {};
  for (const group of (segment.common_keyframes ?? []) as Json[]) {
    const prop = KEYFRAME_PROPS[group.property_type];
    if (!prop) continue;
    const list: Keyframe[] = (group.keyframe_list as Json[])
      .map((keyframe) => ({ offset: keyframe.time_offset, value: keyframe.values?.[0] ?? 0 }))
      .sort((a, b) => a.offset - b.offset);
    if (list.length) result[prop] = list;
  }
  return result;
}

/**
 * Splitting a clip in CapCut copies its marker list to every piece, so the same
 * marker repeats. Times read as timeline time: one audio marker in a real draft
 * only falls inside its clip that way.
 */
function markersOf(draft: Json): Marker[] {
  const unique = new Map<string, Marker>();
  for (const group of (draft.materials.time_marks ?? []) as Json[]) {
    for (const item of (group.mark_items ?? []) as Json[]) {
      const time = item.time_range?.start;
      if (typeof time !== "number") continue;
      const label = item.title || "Marcador";
      unique.set(`${label}@${time}`, { id: newId(), time, label, color: item.color || MARKER_COLOR });
    }
  }
  return [...unique.values()].sort((a, b) => a.time - b.time);
}

export function importCapCutDraft(draft: Json): DraftImport {
  const lost = new Map<string, number>();
  const note = (label: string) => lost.set(label, (lost.get(label) ?? 0) + 1);

  const project = createProject(draft.name || "Draft importado");
  project.fps = draft.fps || 30;
  project.canvas = { width: draft.canvas_config.width, height: draft.canvas_config.height };

  const materials = indexMaterials(draft);
  const offlineFiles: Record<string, string> = {};
  const mediaByDraftId = new Map<string, string>();

  const mediaMaterial = ({ category, item }: DraftEntry): Material | null => {
    const existing = mediaByDraftId.get(item.id);
    if (existing) return project.materials[existing] ?? null;
    if (category !== "videos" && category !== "audios") return null;
    const original = fileName(item.path ?? "");
    const material: Material = {
      id: newId(),
      kind: category === "audios" ? "audio" : item.type === "photo" ? "image" : "video",
      name: original || item.material_name || item.name || "mídia",
      duration: item.duration ?? 0,
      width: item.width ?? 0,
      height: item.height ?? 0,
      hasAudio: category === "audios" || Boolean(item.has_audio),
      offline: true,
    };
    project.materials[material.id] = material;
    mediaByDraftId.set(item.id, material.id);
    offlineFiles[material.id] = material.name;
    return material;
  };

  const textMaterial = (entry: DraftEntry): Material | null => {
    let source: Json | undefined = entry.item;
    if (entry.category === "text_templates") {
      note("modelos de legenda (só o texto foi mantido)");
      source = materials.get(entry.item.text_info_resources?.[0]?.text_material_id)?.item;
    }
    if (!source) return null;
    const material = toTextMaterial(source);
    project.materials[material.id] = material;
    return material;
  };

  for (const draftTrack of draft.tracks as Json[]) {
    const type = draftTrack.type as string;
    if (type !== "video" && type !== "text" && type !== "audio") {
      note(type === "effect" ? "faixas de efeito" : `faixas do tipo ${type}`);
      continue;
    }
    const peers = project.tracks.filter((track) => track.type === type).length;
    const track: Track = {
      id: newId(),
      type,
      name: draftTrack.name || `${TRACK_LABEL[type]} ${peers + 1}`,
      muted: false,
      hidden: false,
      segments: [],
    };

    for (const draftSegment of draftTrack.segments as Json[]) {
      const entry = materials.get(draftSegment.material_id);
      const material = entry && (type === "text" ? textMaterial(entry) : mediaMaterial(entry));
      if (!material) {
        note("clipes com material desconhecido");
        continue;
      }

      const adjust = { ...DEFAULT_ADJUST };
      let transitionDuration = 0;
      for (const id of (draftSegment.extra_material_refs ?? []) as string[]) {
        const ref = materials.get(id);
        if (!ref) continue;
        const { category, item } = ref;
        if (category === "transitions") {
          transitionDuration = item.duration ?? 0;
          note("transições (convertidas para fade)");
        } else if (category === "effects") {
          const known = ADJUST_TYPES.find((name) => name === item.type);
          if (known) adjust[known] = Math.round((item.value ?? 0) * 100);
          else if (item.value) note(`ajustes "${item.type}"`);
        } else if (category === "video_effects") {
          note("efeitos de vídeo");
        } else if (category === "audio_effects") {
          note("efeitos de áudio");
        } else if (category === "material_animations" && item.animations?.length) {
          note("animações de clipe");
        }
      }

      const { clip, source_timerange: source, target_timerange: target } = draftSegment;
      track.segments.push({
        id: newId(),
        materialId: material.id,
        target: { start: target.start, duration: target.duration },
        source: source
          ? { start: source.start, duration: source.duration }
          : { start: 0, duration: target.duration },
        speed: draftSegment.speed || 1,
        volume: draftSegment.volume ?? 1,
        fadeIn: 0,
        fadeOut: 0,
        transform: clip
          ? {
              x: clip.transform.x,
              y: clip.transform.y,
              scale: clip.scale.x,
              rotation: clip.rotation,
              opacity: clip.alpha,
            }
          : { ...DEFAULT_TRANSFORM },
        adjust,
        keyframes: keyframesOf(draftSegment),
        transitionOut: transitionDuration ? { type: "fade", duration: transitionDuration } : null,
        ...(draftSegment.is_tone_modify ? { changePitch: true } : {}),
        ...(clip?.flip?.horizontal ? { flipX: true } : {}),
        ...(clip?.flip?.vertical ? { flipY: true } : {}),
      });
    }

    track.segments.sort((a, b) => a.target.start - b.target.start);
    if (track.segments.length) project.tracks.push(track);
  }

  project.markers = markersOf(draft);

  const warnings = [...lost]
    .sort((a, b) => b[1] - a[1])
    .map(([label, total]) => `${total}× ${label}`);
  return { project, warnings, offlineFiles };
}
