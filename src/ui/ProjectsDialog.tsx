import { useEffect, useState } from "react";
import type { SavedProject } from "../engine/persist";
import { deleteProject, listProjects, newProject, switchProject } from "./actions";
import { Icon } from "./icons";
import { useEditor } from "./store";

function whenSaved(time: number): string {
  if (!time) return "Sem data";
  return new Date(time).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
}

/** The projects kept in this browser. Their files stay until a project is deleted. */
export function ProjectsDialog({ onClose }: { onClose(): void }) {
  const current = useEditor((state) => state.project.id);
  const [projects, setProjects] = useState<SavedProject[] | null>(null);
  const [busy, setBusy] = useState(false);
  const refresh = () => void listProjects().then(setProjects);
  useEffect(refresh, []);

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    await work();
    setBusy(false);
    onClose();
  };

  return (
    <div className="dialog-backdrop" role="dialog" aria-modal="true" aria-label="Projetos">
      <div className="dialog projects">
        <h2>Projetos</h2>
        {projects && projects.length === 0 ? <p className="panel-hint">Nenhum projeto salvo ainda.</p> : null}
        <ul className="project-list">
          {projects?.map(({ id, name, savedAt }) => (
            <li key={id} className={id === current ? "is-current" : undefined}>
              <button
                type="button"
                className="project-open"
                disabled={busy || id === current}
                data-testid="project-open"
                onClick={() => void run(() => switchProject(id))}
              >
                <strong>{name}</strong>
                <span>{id === current ? "Aberto agora" : whenSaved(savedAt)}</span>
              </button>
              <button
                type="button"
                className="tool tool-icon"
                disabled={busy || id === current}
                title="Apagar este projeto"
                aria-label={`Apagar ${name}`}
                data-testid="project-delete"
                onClick={() => {
                  if (!window.confirm(`Apagar "${name}"? Isso não pode ser desfeito.`)) return;
                  void deleteProject(id).then(refresh);
                }}
              >
                <Icon name="trash" size={16} />
              </button>
            </li>
          ))}
        </ul>
        <div className="dialog-actions">
          <button type="button" onClick={onClose}>Fechar</button>
          <button type="button" className="primary" disabled={busy} data-testid="project-new" onClick={() => void run(newProject)}>
            Novo projeto
          </button>
        </div>
      </div>
    </div>
  );
}
