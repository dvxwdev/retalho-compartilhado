import { useCallback, useEffect, useRef, useState, type PointerEvent } from "react";
import { sampleTransform } from "../core/keyframes";
import { projectDuration } from "../core/model";
import { setProp } from "../core/ops";
import { resolveFrame } from "../core/resolve";
import { boxContains, layerBox } from "../engine/compositor";
import { selectedOffset, stepFrames, toggleLightPreview } from "./actions";
import { formatTime } from "./format";
import { edit, getState, player, setState, useEditor } from "./store";

const MAX_PREVIEW_SIDE = 1280;

let dragCounter = 0;

function Clock() {
  const playhead = useEditor((current) => current.playhead);
  const project = useEditor((current) => current.project);
  return (
    <span className="clock" data-testid="clock">
      <strong>{formatTime(playhead, project.fps)}</strong> / {formatTime(projectDuration(project), project.fps)}
    </span>
  );
}

export function Preview() {
  const canvasSize = useEditor((current) => current.project.canvas);
  const playing = useEditor((current) => current.playing);
  const light = useEditor((current) => current.lightPreview);
  const task = useEditor((current) => current.task);
  const stageRef = useRef<HTMLDivElement>(null);
  const [stage, setStage] = useState({ width: 0, height: 0 });

  const scale = Math.min(1, MAX_PREVIEW_SIDE / Math.max(canvasSize.width, canvasSize.height));
  const width = Math.round(canvasSize.width * scale);
  const height = Math.round(canvasSize.height * scale);

  const attach = useCallback((canvas: HTMLCanvasElement | null) => player.attach(canvas), []);

  useEffect(() => {
    const element = stageRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      const { width: stageWidth, height: stageHeight } = entry!.contentRect;
      setStage({ width: stageWidth, height: stageHeight });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const fit = Math.min(stage.width / width, stage.height / height);

  useEffect(() => {
    void player.renderStill();
  }, [width, height]);

  const onPointerDown = (event: PointerEvent<HTMLCanvasElement>) => {
    const canvas = event.currentTarget;
    const { project, playhead, selection } = getState();
    const rect = canvas.getBoundingClientRect();
    const toProject = (clientX: number, clientY: number) => ({
      x: ((clientX - rect.left) / rect.width) * project.canvas.width,
      y: ((clientY - rect.top) / rect.height) * project.canvas.height,
    });
    const origin = toProject(event.clientX, event.clientY);
    const layers = resolveFrame(project, playhead);
    const hits = layers.filter(
      (layer) => layer.material.kind !== "adjustment" && boxContains(layerBox(layer, project), origin.x, origin.y),
    );
    const hit = hits.find((layer) => layer.segment.id === selection) ?? hits[hits.length - 1];
    setState({ selection: hit?.segment.id ?? null, alsoSelected: [] });
    if (!hit) return;

    canvas.setPointerCapture(event.pointerId);
    const key = `preview:${(dragCounter += 1)}`;
    const { id } = hit.segment;
    // Dragging edits the resting place; an animation in progress must not be baked into it.
    const { x, y } = sampleTransform(hit.segment, selectedOffset());
    const onMove = (move: globalThis.PointerEvent) => {
      const point = toProject(move.clientX, move.clientY);
      const nextX = x + ((point.x - origin.x) / project.canvas.width) * 2;
      const nextY = y - ((point.y - origin.y) / project.canvas.height) * 2;
      const offset = selectedOffset();
      edit((current) => setProp(setProp(current, id, "x", nextX, offset), id, "y", nextY, offset), key);
    };
    const onUp = () => {
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
    };
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerup", onUp);
  };

  return (
    <section className="preview" aria-label="Pré-visualização">
      <div className="preview-stage" ref={stageRef}>
        <canvas
          ref={attach}
          width={width}
          height={height}
          style={{ width: width * fit, height: height * fit }}
          onPointerDown={onPointerDown}
          data-testid="preview"
        />
      </div>
      <div className="transport">
        <Clock />
        <div className="transport-buttons">
          <button onClick={() => player.seek(0)} title="Início (Home)">Início</button>
          <button onClick={() => stepFrames(-1)} title="Quadro anterior (←)" aria-label="Quadro anterior">‹</button>
          <button className="primary" onClick={() => player.toggle()} title="Reproduzir (Espaço)" data-testid="play">
            {playing ? "Pausar" : "Reproduzir"}
          </button>
          <button onClick={() => stepFrames(1)} title="Próximo quadro (→)" aria-label="Próximo quadro">›</button>
        </div>
        <button
          className="preview-mode"
          aria-pressed={light}
          disabled={task !== null}
          title="Edita com uma cópia de 540p, mais fluida em vídeos grandes. A exportação sempre usa o original."
          data-testid="light-preview"
          onClick={() => void toggleLightPreview()}
        >
          {task?.label.startsWith("Criando") && task.progress !== null
            ? `Criando ${Math.round(task.progress * 100)}%`
            : "Preview leve"}
        </button>
      </div>
    </section>
  );
}
