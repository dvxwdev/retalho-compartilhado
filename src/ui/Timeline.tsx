import { useEffect, useMemo, useRef, type CSSProperties, type DragEvent, type PointerEvent } from "react";
import {
  SECOND,
  isMediaMaterial,
  projectDuration,
  segmentEnd,
  trackTypeFor,
  type Marker,
  type Project,
  type Segment,
  type Track,
  type Us,
} from "../core/model";
import {
  beatTimes,
  moveSegment,
  removeMarker,
  shiftSegments,
  snap,
  snapPoints,
  trimEnd,
  trimStart,
  updateTrack,
} from "../core/ops";
import { pool } from "../engine/media";
import {
  addToTimeline,
  copySelection,
  deleteSelection,
  duplicateSelection,
  extractSelectionAudio,
  freezeAtPlayhead,
  pasteAtPlayhead,
  selectClip,
  selectedClips,
  splitAtPlayhead,
  toggleInSelection,
  toggleMarkerAtPlayhead,
  toggleNarration,
} from "./actions";
import { formatTime } from "./format";
import { Icon } from "./icons";
import { edit, getState, player, setState, useEditor } from "./store";

export const MATERIAL_MIME = "application/x-retalho-material";

const HEADER_WIDTH = 132;
const SNAP_PIXELS = 8;
const DRAG_THRESHOLD_PIXELS = 3;
const MIN_ZOOM = 8;
const MAX_ZOOM = 800;
const TICK_STEPS = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];

let gestureCounter = 0;

function laneOrder(tracks: Track[]): Track[] {
  const ofType = (type: Track["type"]) => tracks.filter((track) => track.type === type);
  return [...ofType("text").reverse(), ...ofType("video").reverse(), ...ofType("audio")];
}

function laneAt(x: number, y: number): HTMLElement | null {
  return (
    document
      .elementsFromPoint(x, y)
      .find((element): element is HTMLElement => element instanceof HTMLElement && "trackId" in element.dataset) ??
    null
  );
}

function Waveform({ materialId, segment, width }: { materialId: string; segment: Segment; width: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const revision = useEditor((current) => current.mediaRevision);

  useEffect(() => {
    const canvas = canvasRef.current;
    const wave = pool.waveform(materialId);
    if (!canvas || !wave) return;
    const pixels = Math.max(1, Math.min(Math.round(width), 4096));
    canvas.width = pixels;
    canvas.height = 40;
    const context = canvas.getContext("2d")!;
    context.clearRect(0, 0, pixels, 40);
    context.fillStyle = "rgba(255,255,255,.55)";
    const startSecond = segment.source.start / SECOND;
    const lengthSecond = segment.source.duration / SECOND;
    for (let x = 0; x < pixels; x += 1) {
      const second = startSecond + (x / pixels) * lengthSecond;
      const peak = wave.peaks[Math.floor(second * wave.perSecond)] ?? 0;
      const height = Math.max(1, Math.min(1, peak * segment.volume) * 38);
      context.fillRect(x, 20 - height / 2, 1, height);
    }
  }, [materialId, segment.source.start, segment.source.duration, segment.volume, width, revision]);

  return <canvas ref={canvasRef} className="clip-wave" />;
}

function Clip({ project, track, segment, zoom }: { project: Project; track: Track; segment: Segment; zoom: number }) {
  const selected = useEditor((current) => current.selection === segment.id || current.alsoSelected.includes(segment.id));
  useEditor((current) => current.mediaRevision);
  const material = project.materials[segment.materialId];
  const left = (segment.target.start / SECOND) * zoom;
  const width = Math.max(2, (segment.target.duration / SECOND) * zoom);
  const offline = material && isMediaMaterial(material) && material.offline;

  const begin = (event: PointerEvent<HTMLElement>, mode: "move" | "start" | "end") => {
    if (event.button !== 0) return;
    event.stopPropagation();
    if (event.ctrlKey || event.metaKey) {
      toggleInSelection(segment.id);
      return;
    }
    const { snapping, playhead, project: base } = getState();
    if (!selectedClips().includes(segment.id)) selectClip(segment.id);
    const together = selectedClips().filter((id) => id !== segment.id);
    const element = event.currentTarget;
    element.setPointerCapture(event.pointerId);

    const key = `drag:${(gestureCounter += 1)}`;
    const originX = event.clientX;
    const points = snapping ? snapPoints(base, playhead, segment.id) : [];
    const tolerance = (SNAP_PIXELS / zoom) * SECOND;
    let dragging = false;

    const onMove = (move: globalThis.PointerEvent) => {
      const pixels = move.clientX - originX;
      if (!dragging && Math.abs(pixels) < DRAG_THRESHOLD_PIXELS && mode !== "move") return;
      const lane = mode === "move" ? laneAt(move.clientX, move.clientY) : null;
      const changedLane = lane && lane.dataset.trackId !== track.id;
      if (!dragging && Math.abs(pixels) < DRAG_THRESHOLD_PIXELS && !changedLane) return;
      dragging = true;
      const delta = (pixels / zoom) * SECOND;

      if (mode === "start") {
        const wanted = snap(segment.target.start + delta, points, tolerance);
        edit(() => trimStart(base, segment.id, wanted), key);
      } else if (mode === "end") {
        const wanted = snap(segmentEnd(segment) + delta, points, tolerance);
        edit(() => trimEnd(base, segment.id, wanted), key);
      } else {
        const wanted = segment.target.start + delta;
        const byStart = snap(wanted, points, tolerance);
        const byEnd = snap(wanted + segment.target.duration, points, tolerance) - segment.target.duration;
        const start = Math.abs(byStart - wanted) >= Math.abs(byEnd - wanted) ? byStart : byEnd;
        const trackId = lane?.dataset.trackType === track.type ? lane.dataset.trackId! : track.id;
        if (together.length) {
          edit(() => shiftSegments(base, [segment.id, ...together], start - segment.target.start), key);
        } else {
          edit(() => moveSegment(base, segment.id, start, trackId), key);
        }
      }
    };
    const onUp = () => {
      element.removeEventListener("pointermove", onMove);
      element.removeEventListener("pointerup", onUp);
      element.removeEventListener("pointercancel", onUp);
    };
    element.addEventListener("pointermove", onMove);
    element.addEventListener("pointerup", onUp);
    element.addEventListener("pointercancel", onUp);
  };

  const cover = material && isMediaMaterial(material) && track.type !== "audio" ? pool.cover(material.id) : undefined;
  const label = !material
    ? "?"
    : material.kind === "text"
      ? material.text
      : material.kind === "shape"
        ? "Forma"
        : material.kind === "adjustment"
          ? "Ajuste"
          : material.name;

  return (
    <div
      className={`clip clip-${track.type}${selected ? " is-selected" : ""}${offline ? " is-offline" : ""}${track.locked ? " is-locked" : ""}`}
      style={{ left, width, backgroundImage: cover ? `url(${cover})` : undefined }}
      data-segment-id={segment.id}
      title={label}
      onPointerDown={(event) => begin(event, "move")}
    >
      {material && isMediaMaterial(material) && material.hasAudio && !segment.frozen ? (
        <Waveform materialId={material.id} segment={segment} width={width} />
      ) : null}
      <span className="clip-label">
        {segment.frozen ? "Congelado · " : ""}
        {segment.reversed ? "Invertido · " : ""}
        {segment.speed !== 1 ? `${segment.speed.toFixed(2)}× · ` : ""}
        {label}
      </span>
      {[...new Set(Object.values(segment.keyframes).flatMap((list) => list!.map((item) => item.offset)))].map((offset) => (
        <span key={offset} className="clip-keyframe" style={{ left: (offset / SECOND) * zoom }} />
      ))}
      {beatTimes(segment).map((beat) => (
        <span
          key={beat}
          className="clip-beat"
          data-testid="beat"
          style={{ left: ((beat - segment.target.start) / SECOND) * zoom }}
        />
      ))}
      {segment.transitionOut ? <span className="clip-transition" title="Transição" /> : null}
      <span className="clip-handle clip-handle-start" onPointerDown={(event) => begin(event, "start")} />
      <span className="clip-handle clip-handle-end" onPointerDown={(event) => begin(event, "end")} />
    </div>
  );
}

function Lane({ project, track, zoom }: { project: Project; track: Track; zoom: number }) {
  return (
    <div className={`lane lane-${track.type}`}>
      <div className="lane-header">
        <span className="lane-name">{track.name}</span>
        <button
          className={`icon-toggle lock-toggle${track.locked ? " is-off" : ""}`}
          title={track.locked ? "Desbloquear faixa" : "Bloquear faixa"}
          aria-label={`${track.locked ? "Desbloquear" : "Bloquear"} ${track.name}`}
          aria-pressed={Boolean(track.locked)}
          data-testid="track-lock"
          onClick={() => edit((current) => updateTrack(current, track.id, { locked: !track.locked }))}
        >
          <svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true">
            <rect x="2" y="5.5" width="8" height="5.5" rx="1" fill="currentColor" />
            <path
              d={track.locked ? "M3.8 5.5V3.6a2.2 2.2 0 0 1 4.4 0v1.9" : "M3.8 5.5V3.6a2.2 2.2 0 0 1 4.3-.7"}
              fill="none"
              stroke="currentColor"
              strokeWidth="1.2"
            />
          </svg>
        </button>
        {track.type !== "text" ? (
          <button
            className={`icon-toggle${track.muted ? " is-off" : ""}`}
            title={track.muted ? "Ativar som" : "Silenciar"}
            aria-pressed={track.muted}
            onClick={() => edit((current) => updateTrack(current, track.id, { muted: !track.muted }))}
          >
            {track.muted ? "Mudo" : "Som"}
          </button>
        ) : null}
        {track.type !== "audio" ? (
          <button
            className={`icon-toggle${track.hidden ? " is-off" : ""}`}
            title={track.hidden ? "Mostrar faixa" : "Ocultar faixa"}
            aria-pressed={track.hidden}
            onClick={() => edit((current) => updateTrack(current, track.id, { hidden: !track.hidden }))}
          >
            {track.hidden ? "Oculta" : "Visível"}
          </button>
        ) : null}
      </div>
      <div className="lane-body" data-track-id={track.id} data-track-type={track.type}>
        {track.segments.map((segment) => (
          <Clip key={segment.id} project={project} track={track} segment={segment} zoom={zoom} />
        ))}
      </div>
    </div>
  );
}

function MarkerFlag({ marker, zoom }: { marker: Marker; zoom: number }) {
  return (
    <button
      className="marker"
      style={{ left: (marker.time / SECOND) * zoom, color: marker.color }}
      title={`${marker.label}. Clique para ir até ele, botão direito para remover.`}
      aria-label={marker.label}
      data-testid="marker"
      onPointerDown={(event) => event.stopPropagation()}
      onClick={() => player.seek(marker.time)}
      onContextMenu={(event) => {
        event.preventDefault();
        edit((project) => removeMarker(project, marker.id));
      }}
    />
  );
}

function Ruler({ width, zoom, fps, markers }: { width: number; zoom: number; fps: number; markers: Marker[] }) {
  const step = TICK_STEPS.find((candidate) => candidate * zoom >= 72) ?? 600;
  const ticks = useMemo(() => {
    const result: number[] = [];
    for (let second = 0; second * zoom < width; second += step) result.push(second);
    return result;
  }, [width, zoom, step]);

  const scrub = (event: PointerEvent<HTMLDivElement>) => {
    const element = event.currentTarget;
    const seekTo = (clientX: number) => {
      const x = clientX - element.getBoundingClientRect().left;
      player.seek(Math.round((Math.max(0, x) / zoom) * SECOND));
    };
    seekTo(event.clientX);
    element.setPointerCapture(event.pointerId);
    const onMove = (move: globalThis.PointerEvent) => seekTo(move.clientX);
    const onUp = () => {
      element.removeEventListener("pointermove", onMove);
      element.removeEventListener("pointerup", onUp);
    };
    element.addEventListener("pointermove", onMove);
    element.addEventListener("pointerup", onUp);
  };

  return (
    <div className="ruler">
      <div className="ruler-corner" />
      <div className="ruler-body" data-testid="ruler" onPointerDown={scrub}>
        {ticks.map((second) => (
          <span key={second} className="tick" style={{ left: second * zoom }}>
            {formatTime(second * SECOND, fps)}
          </span>
        ))}
        {markers.map((marker) => (
          <MarkerFlag key={marker.id} marker={marker} zoom={zoom} />
        ))}
      </div>
    </div>
  );
}

function Playhead({ zoom, scroller }: { zoom: number; scroller: React.RefObject<HTMLDivElement | null> }) {
  const playhead = useEditor((current) => current.playhead);
  const playing = useEditor((current) => current.playing);
  const x = (playhead / SECOND) * zoom;

  useEffect(() => {
    const element = scroller.current;
    if (!element || !playing) return;
    const visibleEnd = element.scrollLeft + element.clientWidth - HEADER_WIDTH;
    if (x > visibleEnd - 40 || x < element.scrollLeft) element.scrollLeft = Math.max(0, x - 80);
  }, [x, playing, scroller]);

  return <div className="playhead" style={{ transform: `translateX(${HEADER_WIDTH + x}px)` }} />;
}

export function Timeline() {
  const project = useEditor((current) => current.project);
  const zoom = useEditor((current) => current.zoom);
  const snapping = useEditor((current) => current.snapping);
  const hasSelection = useEditor((current) => current.selection !== null);
  const hasClipboard = useEditor((current) => current.clipboard !== null);
  const recording = useEditor((current) => current.recording);
  const scroller = useRef<HTMLDivElement>(null);

  // Another project starts from its beginning, not where the last one was left.
  useEffect(() => {
    if (scroller.current) scroller.current.scrollLeft = 0;
  }, [project.id]);

  const duration: Us = projectDuration(project);
  const contentWidth = ((duration / SECOND) + 30) * zoom;
  const lanes = laneOrder(project.tracks);

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    const materialId = event.dataTransfer.getData(MATERIAL_MIME);
    if (!materialId) return;
    event.preventDefault();
    event.stopPropagation();
    const material = project.materials[materialId];
    const element = scroller.current;
    if (!material || !element) return;
    const x = event.clientX - element.getBoundingClientRect().left + element.scrollLeft - HEADER_WIDTH;
    const lane = laneAt(event.clientX, event.clientY);
    const compatible = lane?.dataset.trackType === trackTypeFor(material);
    addToTimeline(materialId, Math.round((Math.max(0, x) / zoom) * SECOND), compatible ? lane!.dataset.trackId : undefined);
  };

  const setZoom = (value: number) => setState({ zoom: Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value)) });

  return (
    <section className="timeline" aria-label="Linha do tempo">
      <div className="timeline-tools">
        <div className="tool-group" role="group" aria-label="Cortar e excluir">
          <button className="tool" onClick={splitAtPlayhead} title="Dividir no cursor (S)" data-testid="split">
            <Icon name="split" size={16} />Dividir
          </button>
          <button className="tool" onClick={() => deleteSelection(false)} disabled={!hasSelection} title="Excluir (Delete)">
            <Icon name="trash" size={16} />Excluir
          </button>
          <button className="tool" onClick={() => deleteSelection(true)} disabled={!hasSelection} title="Excluir e fechar o espaço (Shift+Delete)">
            <Icon name="ripple" size={16} />Fechar espaço
          </button>
        </div>
        <span className="tool-sep" />
        <div className="tool-group" role="group" aria-label="Copiar">
          <button className="tool" onClick={copySelection} disabled={!hasSelection} title="Copiar (Ctrl+C)">
            <Icon name="copy" size={16} />Copiar
          </button>
          <button className="tool" onClick={pasteAtPlayhead} disabled={!hasClipboard} title="Colar no cursor (Ctrl+V)" data-testid="paste">
            <Icon name="paste" size={16} />Colar
          </button>
          <button className="tool" onClick={duplicateSelection} disabled={!hasSelection} title="Duplicar (Ctrl+D)" data-testid="duplicate">
            <Icon name="duplicate" size={16} />Duplicar
          </button>
        </div>
        <span className="tool-sep" />
        <div className="tool-group" role="group" aria-label="Criar a partir do clipe">
          <button className="tool" onClick={freezeAtPlayhead} title="Congela o quadro no cursor por 3 segundos" data-testid="freeze">
            <Icon name="freeze" size={16} />Congelar
          </button>
          <button className="tool" onClick={extractSelectionAudio} disabled={!hasSelection} title="Move o som do vídeo para uma faixa de áudio" data-testid="extract-audio">
            <Icon name="extract" size={16} />Extrair áudio
          </button>
          <button
            className={recording ? "tool is-recording" : "tool"}
            onClick={() => void toggleNarration()}
            title="Grava pelo microfone a partir do cursor. Use fones para o som do vídeo não entrar na gravação."
            data-testid="narration"
          >
            <Icon name="mic" size={16} />{recording ? "Parar gravação" : "Narração"}
          </button>
          <button className="tool" onClick={toggleMarkerAtPlayhead} title="Marcador no cursor (M). Vá até eles com [ e ]" data-testid="add-marker">
            <Icon name="marker" size={16} />Marcador
          </button>
        </div>
        <span className="spacer" />
        <label className="check">
          <input type="checkbox" checked={snapping} onChange={(event) => setState({ snapping: event.target.checked })} />
          Encaixe
        </label>
        <button onClick={() => setZoom(zoom / 1.4)} aria-label="Diminuir zoom">−</button>
        <input
          className="zoom"
          type="range"
          aria-label="Zoom"
          min={Math.log(MIN_ZOOM)}
          max={Math.log(MAX_ZOOM)}
          step={0.01}
          value={Math.log(zoom)}
          style={{ "--fill-to": `${((Math.log(zoom) - Math.log(MIN_ZOOM)) / (Math.log(MAX_ZOOM) - Math.log(MIN_ZOOM))) * 100}%` } as CSSProperties}
          onChange={(event) => setZoom(Math.exp(Number(event.target.value)))}
        />
        <button onClick={() => setZoom(zoom * 1.4)} aria-label="Aumentar zoom">+</button>
      </div>
      <div
        className="timeline-scroll"
        ref={scroller}
        onDragOver={(event) => {
          if (event.dataTransfer.types.includes(MATERIAL_MIME)) event.preventDefault();
        }}
        onDrop={onDrop}
        onPointerDown={(event) => {
          if ((event.target as HTMLElement).closest(".lane-body")) setState({ selection: null, alsoSelected: [] });
        }}
      >
        <div className="timeline-content" style={{ width: HEADER_WIDTH + contentWidth }}>
          <Ruler width={contentWidth} zoom={zoom} fps={project.fps} markers={project.markers ?? []} />
          {lanes.map((track) => (
            <Lane key={track.id} project={project} track={track} zoom={zoom} />
          ))}
          {lanes.length === 0 ? (
            <p className="timeline-empty">Arraste mídia para cá ou use o botão + em um item da biblioteca.</p>
          ) : null}
          <Playhead zoom={zoom} scroller={scroller} />
        </div>
      </div>
    </section>
  );
}
