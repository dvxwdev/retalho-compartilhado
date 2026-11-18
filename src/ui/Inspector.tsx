import { useRef, type KeyboardEvent } from "react";
import { findSegment, type Material } from "../core/model";
import { pasteAttributesToSelection } from "./actions";
import { formatDuration } from "./format";
import { Icon, type IconName } from "./icons";
import { BackgroundPage, CLIP_PAGES, type ClipContext } from "./panel/pages";
import { setState, useEditor } from "./store";

interface RailItem {
  id: string;
  label: string;
  icon: IconName;
  isSet?: boolean;
}

function Rail({ items, current, onSelect }: { items: RailItem[]; current: string; onSelect(id: string): void }) {
  const list = useRef<HTMLDivElement>(null);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = items.findIndex((item) => item.id === current);
    const target = {
      ArrowDown: (index + 1) % items.length,
      ArrowUp: (index - 1 + items.length) % items.length,
      Home: 0,
      End: items.length - 1,
    }[event.key];
    if (target === undefined) return;
    event.preventDefault();
    // The editor also listens to these keys; here they belong to the list.
    event.stopPropagation();
    onSelect(items[target]!.id);
    list.current?.querySelectorAll("button")[target]?.focus();
  };

  return (
    <div className="rail" role="tablist" aria-orientation="vertical" aria-label="Categorias" ref={list} onKeyDown={onKeyDown}>
      {items.map(({ id, label, icon, isSet }) => (
        <button
          key={id}
          type="button"
          role="tab"
          id={`tab-${id}`}
          aria-selected={id === current}
          aria-controls="panel-page"
          tabIndex={id === current ? 0 : -1}
          className="rail-item"
          data-testid={`tab-${id}`}
          onClick={() => onSelect(id)}
        >
          <Icon name={icon} size={19} />
          <span>{label}</span>
          {isSet ? <i className="rail-dot" title="Tem ajuste aplicado" /> : null}
        </button>
      ))}
    </div>
  );
}

const KIND_ICON: Record<Material["kind"], IconName> = {
  video: "video",
  image: "image",
  audio: "audio",
  text: "text",
  shape: "star",
  adjustment: "color",
};

function clipName(material: Material): string {
  if (material.kind === "shape") return "Forma";
  if (material.kind === "adjustment") return "Camada de ajuste";
  return material.kind === "text" ? material.text.split("\n")[0] || "Texto" : material.name;
}

export function Inspector() {
  const project = useEditor((current) => current.project);
  const selection = useEditor((current) => current.selection);
  const panelTab = useEditor((current) => current.panelTab);
  const hasClipboard = useEditor((current) => current.clipboard !== null);
  const audioBusy = useEditor((current) => current.audioBusy > 0);
  const task = useEditor((current) => current.task);
  const others = useEditor((current) => current.alsoSelected.length);
  const found = selection ? findSegment(project, selection) : null;
  const material = found ? project.materials[found.segment.materialId] : undefined;
  const select = (id: string) => setState({ panelTab: id });

  if (!found || !material) {
    return (
      <aside className="inspector" aria-label="Propriedades">
        <Rail items={[{ id: "background", label: "Fundo", icon: "background", isSet: Boolean(project.background) }]} current="background" onSelect={select} />
        <div className="panel">
          <header className="panel-head">
            <div className="panel-name">
              <strong>Tela do projeto</strong>
              <span>Selecione um clipe para editá-lo</span>
            </div>
          </header>
          <div className="inspector-body" id="panel-page" role="tabpanel" aria-labelledby="tab-background">
            <BackgroundPage />
          </div>
        </div>
      </aside>
    );
  }

  const context: ClipContext = { segment: found.segment, material, trackType: found.track.type };
  const pages = CLIP_PAGES.filter((page) => page.applies(context));
  // A category stays open between clips, as long as the new clip has it.
  const page = pages.find((item) => item.id === panelTab) ?? pages[0]!;
  const locked = Boolean(found.track.locked);

  return (
    <aside className="inspector" aria-label="Propriedades">
      <Rail
        items={pages.map(({ id, label, icon, isSet }) => ({ id, label, icon, isSet: isSet?.(context) }))}
        current={page.id}
        onSelect={select}
      />
      <div className="panel">
        <header className="panel-head">
          <span className="panel-kind"><Icon name={KIND_ICON[material.kind]} size={16} /></span>
          <div className="panel-name">
            <strong title={clipName(material)}>{clipName(material)}</strong>
            <span>
              {task
                ? `${task.label}${task.progress === null ? "…" : ` ${Math.round(task.progress * 100)}%`}`
                : others
                  ? `${others + 1} clipes selecionados`
                  : audioBusy
                  ? "Processando áudio…"
                  : `${page.label} · ${formatDuration(found.segment.target.duration)}`}
            </span>
          </div>
          <button
            type="button"
            className="tool tool-icon"
            onClick={pasteAttributesToSelection}
            disabled={!hasClipboard || locked}
            title="Colar atributos do clipe copiado (Ctrl+Shift+V)"
            aria-label="Colar atributos"
            data-testid="paste-attributes"
          >
            <Icon name="style" size={16} />
          </button>
        </header>
        {locked ? <p className="panel-lock">Faixa bloqueada. Desbloqueie para editar.</p> : null}
        <fieldset
          className="inspector-body"
          id="panel-page"
          role="tabpanel"
          aria-labelledby={`tab-${page.id}`}
          disabled={locked}
          key={`${found.segment.id}:${page.id}`}
        >
          {page.render(context)}
        </fieldset>
      </div>
    </aside>
  );
}
