import { useEffect, useRef, useState, type DragEvent } from "react";
import {
  copySelection,
  cutSelection,
  deleteSelection,
  duplicateSelection,
  importFiles,
  jumpToMarker,
  selectAll,
  newProject,
  pasteAtPlayhead,
  pasteAttributesToSelection,
  saveProjectFile,
  splitAtPlayhead,
  stepFrames,
  toggleGroup,
  toggleMarkerAtPlayhead,
} from "./actions";
import { ExportDialog } from "./ExportDialog";
import { Icon } from "./icons";
import { Inspector } from "./Inspector";
import { MediaBin } from "./MediaBin";
import { Preview } from "./Preview";
import { ProjectsDialog } from "./ProjectsDialog";
import { edit, player, redo, setState, undo, useEditor } from "./store";
import { Timeline } from "./Timeline";

const CANVAS_PRESETS = [
  { label: "16:9", width: 1920, height: 1080 },
  { label: "9:16", width: 1080, height: 1920 },
  { label: "1:1", width: 1080, height: 1080 },
  { label: "4:5", width: 1080, height: 1350 },
];

function useShortcuts() {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      const typing = target.matches("textarea, select, input:not([type=range]):not([type=checkbox])");
      if (typing) return;
      const command = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();
      if (command && key === "z") {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
      } else if (command && key === "y") {
        event.preventDefault();
        redo();
      } else if (command && key === "a") {
        event.preventDefault();
        selectAll();
      } else if (command && key === "g") {
        event.preventDefault();
        toggleGroup();
      } else if (command && key === "c") {
        copySelection();
      } else if (command && key === "x") {
        cutSelection();
      } else if (command && key === "v") {
        event.preventDefault();
        if (event.shiftKey) pasteAttributesToSelection();
        else pasteAtPlayhead();
      } else if (command && key === "d") {
        event.preventDefault();
        duplicateSelection();
      } else if (event.code === "Space") {
        event.preventDefault();
        player.toggle();
      } else if (key === "s" && !command) {
        splitAtPlayhead();
      } else if (key === "m" && !command) {
        toggleMarkerAtPlayhead();
      } else if (key === "[") {
        jumpToMarker(-1);
      } else if (key === "]") {
        jumpToMarker(1);
      } else if (key === "delete" || key === "backspace") {
        deleteSelection(event.shiftKey);
      } else if (key === "arrowleft") {
        stepFrames(event.shiftKey ? -10 : -1);
      } else if (key === "arrowright") {
        stepFrames(event.shiftKey ? 10 : 1);
      } else if (key === "home") {
        player.seek(0);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

function TopBar({ onExport, onProjects }: { onExport(): void; onProjects(): void }) {
  const name = useEditor((current) => current.project.name);
  const canvas = useEditor((current) => current.project.canvas);
  const canUndo = useEditor((current) => current.canUndo);
  const canRedo = useEditor((current) => current.canRedo);
  const opener = useRef<HTMLInputElement>(null);
  const preset = CANVAS_PRESETS.find(
    (item) => item.width === canvas.width && item.height === canvas.height,
  );

  return (
    <header className="topbar">
      <span className="brand">Retalho</span>
      <input
        className="project-name"
        aria-label="Nome do projeto"
        value={name}
        onChange={(event) => {
          const value = event.target.value;
          edit((project) => ({ ...project, name: value }), "name");
        }}
      />
      <div className="tool-group" role="group" aria-label="Histórico">
        <button className="tool" onClick={undo} disabled={!canUndo} title="Desfazer (Ctrl+Z)">
          <Icon name="undo" size={16} />Desfazer
        </button>
        <button className="tool" onClick={redo} disabled={!canRedo} title="Refazer (Ctrl+Y)">
          <Icon name="redo" size={16} />Refazer
        </button>
      </div>
      <span className="spacer" />
      <label className="check">
        Formato
        <select
          data-testid="canvas-preset"
          value={preset?.label ?? "custom"}
          onChange={(event) => {
            const next = CANVAS_PRESETS.find((item) => item.label === event.target.value);
            if (next) {
              edit((project) => ({ ...project, canvas: { width: next.width, height: next.height } }));
            }
          }}
        >
          {preset ? null : <option value="custom">{canvas.width}×{canvas.height}</option>}
          {CANVAS_PRESETS.map(({ label }) => (
            <option key={label} value={label}>{label}</option>
          ))}
        </select>
      </label>
      <span className="tool-sep" />
      <div className="tool-group" role="group" aria-label="Projeto">
        <button className="tool" onClick={() => void newProject()} title="Começa um projeto vazio. O atual fica guardado em Projetos.">
          <Icon name="file" size={16} />Novo
        </button>
        <button className="tool" onClick={onProjects} data-testid="projects-open" title="Abre outro projeto deste navegador">
          <Icon name="presets" size={16} />Projetos
        </button>
        <button className="tool" onClick={() => opener.current?.click()} title="Abre um arquivo .retalho">
          <Icon name="open" size={16} />Abrir
        </button>
        <button className="tool" onClick={saveProjectFile} title="Salva o projeto e as mídias em um arquivo .retalho">
          <Icon name="save" size={16} />Salvar
        </button>
      </div>
      <input
        ref={opener}
        type="file"
        accept=".retalho"
        hidden
        data-testid="project-input"
        onChange={(event) => {
          const files = [...(event.target.files ?? [])];
          event.target.value = "";
          void importFiles(files);
        }}
      />
      <button className="primary tool" onClick={onExport} data-testid="export-open">
        <Icon name="export" size={16} />Exportar
      </button>
    </header>
  );
}

function Notice() {
  const notice = useEditor((current) => current.notice);
  if (!notice) return null;
  return (
    <div className="notice" role="status" data-testid="notice">
      <div>
        <strong>{notice.text}</strong>
        {notice.details ? (
          <ul>
            {notice.details.map((detail) => (
              <li key={detail}>{detail}</li>
            ))}
          </ul>
        ) : null}
      </div>
      <button onClick={() => setState({ notice: null })} aria-label="Fechar aviso">×</button>
    </div>
  );
}

export function App() {
  const [exporting, setExporting] = useState(false);
  const [choosing, setChoosing] = useState(false);
  useShortcuts();

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.files.length) return;
    event.preventDefault();
    void importFiles([...event.dataTransfer.files]);
  };

  return (
    <div
      className="app"
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes("Files")) event.preventDefault();
      }}
      onDrop={onDrop}
    >
      <TopBar onExport={() => setExporting(true)} onProjects={() => setChoosing(true)} />
      <main className="workspace">
        <MediaBin />
        <Preview />
        <Inspector />
      </main>
      <Timeline />
      <Notice />
      {exporting ? <ExportDialog onClose={() => setExporting(false)} /> : null}
      {choosing ? <ProjectsDialog onClose={() => setChoosing(false)} /> : null}
    </div>
  );
}
