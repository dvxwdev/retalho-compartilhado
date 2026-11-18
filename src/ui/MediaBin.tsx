import { useRef, useState } from "react";
import { isMediaMaterial, type MediaMaterial, type ShapeKind } from "../core/model";
import { pool } from "../engine/media";
import { MOTION_TEMPLATES } from "../core/motionTemplates";
import { addAdjustment, addShape, addTemplate, addText, addToTimeline, importFiles } from "./actions";
import { formatDuration } from "./format";
import { Icon } from "./icons";
import { useEditor } from "./store";
import { MATERIAL_MIME } from "./Timeline";
import { SpeechTab } from "./Transcript";

const KIND_LABEL = { video: "Vídeo", image: "Imagem", audio: "Áudio" };

const SHAPES: { value: ShapeKind; label: string }[] = [
  { value: "rectangle", label: "Retângulo" },
  { value: "circle", label: "Círculo" },
  { value: "triangle", label: "Triângulo" },
  { value: "star", label: "Estrela" },
  { value: "heart", label: "Coração" },
  { value: "line", label: "Linha" },
];

function Elements() {
  return (
    <div className="elements">
      <button className="primary element-text" type="button" data-testid="element-text" onClick={addText}>
        Adicionar texto
      </button>
      <button
        className="element-text"
        type="button"
        data-testid="element-adjustment"
        title="Aplica cor e efeitos em tudo que estiver abaixo dela"
        onClick={addAdjustment}
      >
        Camada de ajuste
      </button>
      <h3>Modelos animados</h3>
      <div className="template-grid">
        {MOTION_TEMPLATES.map(({ value, label }) => (
          <button key={value} type="button" className="element" data-testid={`template-${value}`} onClick={() => addTemplate(value)}>
            <span>{label}</span>
          </button>
        ))}
      </div>
      <h3>Formas</h3>
      <div className="element-grid">
        {SHAPES.map(({ value, label }) => (
          <button key={value} type="button" className="element" data-testid={`element-${value}`} onClick={() => addShape(value)}>
            <Icon name={value} size={22} />
            <span>{label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function Item({ material }: { material: MediaMaterial }) {
  useEditor((current) => current.mediaRevision);
  const cover = pool.cover(material.id);
  return (
    <li
      className={`bin-item${material.offline ? " is-offline" : ""}`}
      draggable={!material.offline}
      onDragStart={(event) => {
        event.dataTransfer.setData(MATERIAL_MIME, material.id);
        event.dataTransfer.effectAllowed = "copy";
      }}
    >
      <div className="bin-thumb" style={{ backgroundImage: cover ? `url(${cover})` : undefined }}>
        {!cover ? <span>{KIND_LABEL[material.kind]}</span> : null}
        <button
          className="bin-add"
          title="Adicionar no cursor"
          aria-label={`Adicionar ${material.name} à linha do tempo`}
          onClick={() => addToTimeline(material.id)}
          data-testid="bin-add"
        >
          +
        </button>
      </div>
      <div className="bin-name" title={material.name}>{material.name}</div>
      <div className="bin-meta">
        {material.offline ? "Offline" : material.kind === "image" ? "Imagem" : formatDuration(material.duration)}
      </div>
    </li>
  );
}

export function MediaBin() {
  const materials = useEditor((current) => current.project.materials);
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<"media" | "elements" | "transcript">("media");
  const items = Object.values(materials).filter(isMediaMaterial);

  const load = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true);
    await importFiles([...files]);
    setBusy(false);
    if (input.current) input.current.value = "";
  };

  return (
    <aside className="bin" aria-label="Biblioteca de mídia">
      <div className="bin-tabs subtabs" role="tablist" aria-label="Painel da esquerda">
        <button type="button" role="tab" className="subtab" aria-selected={tab === "media"} onClick={() => setTab("media")}>
          Mídia
        </button>
        <button
          type="button"
          role="tab"
          className="subtab"
          aria-selected={tab === "elements"}
          data-testid="bin-elements"
          onClick={() => setTab("elements")}
        >
          Elementos
        </button>
        <button
          type="button"
          role="tab"
          className="subtab"
          aria-selected={tab === "transcript"}
          data-testid="bin-transcript"
          onClick={() => setTab("transcript")}
        >
          Fala
        </button>
      </div>
      {tab === "transcript" ? <SpeechTab /> : null}
      {tab === "elements" ? <Elements /> : null}
      <div className="bin-actions" hidden={tab !== "media"}>
        <button className="primary" onClick={() => input.current?.click()} disabled={busy}>
          {busy ? "Importando…" : "Importar"}
        </button>
        <button onClick={addText} data-testid="add-text">Texto</button>
        <input
          ref={input}
          type="file"
          multiple
          hidden
          data-testid="file-input"
          accept="video/*,audio/*,image/*,.json,.srt,.cube,.ttf,.otf,.woff,.woff2,.retalho"
          onChange={(event) => void load(event.target.files)}
        />
      </div>
      {tab !== "media" ? null : items.length ? (
        <ul className="bin-list">
          {items.map((material) => (
            <Item key={material.id} material={material} />
          ))}
        </ul>
      ) : (
        <p className="panel-empty">
          Importe vídeos, áudios e imagens, ou um <code>draft_content.json</code> do CapCut. Também dá para soltar arquivos em qualquer lugar da janela.
        </p>
      )}
    </aside>
  );
}
