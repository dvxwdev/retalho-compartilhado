import { useRef, useState } from "react";
import { findSegment, isMediaMaterial, outputSize, projectDuration, segmentEnd, type Project, type Us } from "../core/model";
import { extractRange } from "../core/ops";
import { formatSrt, subtitleCues } from "../core/subtitles";
import { exportAudio, exportGif, exportProject, exportStill } from "../engine/exporter";
import { formatDuration } from "./format";
import { Toggle } from "./panel/controls";
import { getState, player, useEditor } from "./store";

const QUALITIES = [
  { label: "Alta", value: 0.2 },
  { label: "Média", value: 0.12 },
  { label: "Leve", value: 0.07 },
];

const RESOLUTIONS = [
  { label: "Do projeto", value: 0 },
  { label: "720p", value: 720 },
  { label: "1080p", value: 1080 },
  { label: "1440p", value: 1440 },
  { label: "4K", value: 2160 },
];

const FRAME_RATES = [24, 25, 30, 50, 60];

type Format = "mp4" | "gif" | "wav" | "png" | "srt";

const FORMATS: { value: Format; label: string }[] = [
  { value: "mp4", label: "Vídeo (MP4)" },
  { value: "gif", label: "Animação (GIF)" },
  { value: "wav", label: "Só o áudio (WAV)" },
  { value: "png", label: "Quadro atual (PNG)" },
  { value: "srt", label: "Legendas (SRT)" },
];

type Stretch = "all" | "clip" | "markers";

/** What each option covers right now, or null when it does not apply. */
function stretchOf(project: Project, selection: string | null, stretch: Stretch): { from: Us; to: Us } | null {
  if (stretch === "clip") {
    const found = selection ? findSegment(project, selection) : null;
    return found ? { from: found.segment.target.start, to: segmentEnd(found.segment) } : null;
  }
  const markers = project.markers ?? [];
  if (stretch === "markers" && markers.length >= 2) {
    return { from: markers[0]!.time, to: markers[markers.length - 1]!.time };
  }
  return null;
}

type Status =
  | { step: "idle" }
  | { step: "running"; progress: number }
  | { step: "done"; url: string; name: string; size: number; detail: string }
  | { step: "error"; message: string };

function subtitleBlob(project: Project): Blob {
  const cues = subtitleCues(project);
  if (cues.length === 0) throw new Error("O projeto não tem textos para exportar.");
  return new Blob([formatSrt(cues)], { type: "application/x-subrip" });
}

export function ExportDialog({ onClose }: { onClose(): void }) {
  const project = useEditor((current) => current.project);
  const [format, setFormat] = useState<Format>("mp4");
  const [quality, setQuality] = useState(QUALITIES[0]!.value);
  const [shortSide, setShortSide] = useState(0);
  const [fps, setFps] = useState(project.fps);
  const [motionBlur, setMotionBlur] = useState(false);
  const selection = useEditor((current) => current.selection);
  const [stretch, setStretch] = useState<Stretch>("all");
  const [status, setStatus] = useState<Status>({ step: "idle" });
  const abort = useRef<AbortController | null>(null);
  const range = stretchOf(project, selection, stretch);
  const duration = range ? range.to - range.from : projectDuration(project);
  const size = outputSize(project.canvas, format === "mp4" ? shortSide : 0);
  const offline = Object.values(project.materials).filter(
    (material) => isMediaMaterial(material) && material.offline,
  ).length;
  const frameRates = [...new Set([...FRAME_RATES, project.fps])].sort((a, b) => a - b);

  const render = async (current: Project): Promise<{ blob: Blob; detail: string }> => {
    if (format === "gif") {
      const blob = await exportGif(current, {
        signal: abort.current!.signal,
        onProgress: (progress) => setStatus({ step: "running", progress }),
      });
      return { blob, detail: "GIF" };
    }
    if (format === "wav") return { blob: await exportAudio(current), detail: "WAV 16 bits, 48 kHz" };
    if (format === "srt") return { blob: subtitleBlob(current), detail: "SRT" };
    if (format === "png") return { blob: await exportStill(current, getState().playhead), detail: "PNG" };
    const result = await exportProject(current, {
      quality,
      shortSide,
      fps,
      motionBlur,
      signal: abort.current!.signal,
      onProgress: (progress) => setStatus({ step: "running", progress }),
    });
    const detail = [result.videoCodec, result.audioCodec].filter(Boolean).join(" + ").toUpperCase();
    return { blob: result.blob, detail };
  };

  const start = async () => {
    player.pause();
    abort.current = new AbortController();
    setStatus({ step: "running", progress: 0 });
    try {
      const whole = getState().project;
      const current = range && format !== "png" ? extractRange(whole, range.from, range.to) : whole;
      const { blob, detail } = await render(current);
      const name = `${current.name.replace(/[\\/:*?"<>|]/g, "-") || "retalho"}.${format}`;
      setStatus({ step: "done", url: URL.createObjectURL(blob), name, size: blob.size, detail });
    } catch (error) {
      const failure = error as Error;
      setStatus(
        failure.name === "AbortError"
          ? { step: "idle" }
          : { step: "error", message: failure.message },
      );
    }
    void player.renderStill();
  };

  return (
    <div className="dialog-backdrop" role="dialog" aria-modal="true" aria-label="Exportar">
      <div className="dialog">
        <h2>Exportar</h2>
        <dl className="summary">
          {format === "mp4" || format === "png" ? (
            <>
              <dt>Resolução</dt>
              <dd data-testid="export-size">{size.width} × {size.height}</dd>
            </>
          ) : null}
          {format === "mp4" || format === "wav" ? (
            <>
              <dt>Duração</dt>
              <dd>{formatDuration(duration)}</dd>
            </>
          ) : null}
        </dl>
        {offline && format !== "srt" ? (
          <p className="warning">{offline} mídia(s) offline vão aparecer como aviso no vídeo.</p>
        ) : null}

        {status.step === "idle" || status.step === "error" ? (
          <>
            <label className="field field-select">
              <span className="field-label">Formato</span>
              <select
                data-testid="export-format"
                value={format}
                onChange={(event) => setFormat(event.target.value as Format)}
              >
                {FORMATS.map(({ value, label }) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
            </label>
            {format !== "png" ? (
              <label className="field field-select">
                <span className="field-label">Trecho</span>
                <select data-testid="export-stretch" value={stretch} onChange={(event) => setStretch(event.target.value as Stretch)}>
                  <option value="all">Tudo</option>
                  <option value="clip" disabled={!selection}>Clipe selecionado</option>
                  <option value="markers" disabled={(project.markers?.length ?? 0) < 2}>Entre o primeiro e o último marcador</option>
                </select>
              </label>
            ) : null}
            {format === "mp4" ? (
              <>
                <label className="field field-select">
                  <span className="field-label">Resolução</span>
                  <select
                    data-testid="export-resolution"
                    value={shortSide}
                    onChange={(event) => setShortSide(Number(event.target.value))}
                  >
                    {RESOLUTIONS.map(({ value, label }) => (
                      <option key={value} value={value}>{label}</option>
                    ))}
                  </select>
                </label>
                <label className="field field-select">
                  <span className="field-label">Quadros/s</span>
                  <select
                    data-testid="export-fps"
                    value={fps}
                    onChange={(event) => setFps(Number(event.target.value))}
                  >
                    {frameRates.map((value) => (
                      <option key={value} value={value}>{value}</option>
                    ))}
                  </select>
                </label>
                <label className="field field-select">
                  <span className="field-label">Qualidade</span>
                  <select value={quality} onChange={(event) => setQuality(Number(event.target.value))}>
                    {QUALITIES.map(({ label, value }) => (
                      <option key={value} value={value}>{label}</option>
                    ))}
                  </select>
                </label>
                <Toggle
                  label="Desfoque de movimento (mais lento)"
                  testId="motion-blur"
                  checked={motionBlur}
                  onChange={setMotionBlur}
                />
              </>
            ) : null}
            {status.step === "error" ? <p className="warning">Falha ao exportar: {status.message}</p> : null}
            <div className="dialog-actions">
              <button onClick={onClose}>Fechar</button>
              <button
                className="primary"
                onClick={() => void start()}
                disabled={duration === 0}
                data-testid="export-start"
              >
                Exportar
              </button>
            </div>
          </>
        ) : null}

        {status.step === "running" ? (
          <>
            <progress value={status.progress} max={1} aria-label="Progresso da exportação" />
            <p className="progress-label">{Math.round(status.progress * 100)}%</p>
            <div className="dialog-actions">
              <button onClick={() => abort.current?.abort()}>Cancelar</button>
            </div>
          </>
        ) : null}

        {status.step === "done" ? (
          <>
            <p data-testid="export-done">
              Pronto: {(status.size / 1_048_576).toFixed(1)} MB, {status.detail}.
            </p>
            <div className="dialog-actions">
              <button onClick={onClose} data-testid="export-close">Fechar</button>
              <a className="button primary" href={status.url} download={status.name} data-testid="export-link">
                Baixar {status.name}
              </a>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
