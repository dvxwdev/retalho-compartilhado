import { useState } from "react";
import { findSegment, projectDuration } from "../core/model";
import { replaceInTexts, updateMaterial } from "../core/ops";
import { subtitleClips } from "../core/subtitles";
import { trackWords, type PlacedWord } from "../core/speech";
import { cutWords, fixWord } from "./actions";
import { formatTime } from "./format";
import { edit, player, setState, useEditor } from "./store";

/** The speech of the selected clip's track. Removing words here cuts them from the video. */
export function Transcript() {
  const project = useEditor((current) => current.project);
  const selection = useEditor((current) => current.selection);
  const playhead = useEditor((current) => current.playhead);
  const [range, setRange] = useState<{ from: number; to: number } | null>(null);

  const found = selection ? findSegment(project, selection) : null;
  const words = found ? trackWords(project, found.track.id) : [];
  if (words.length === 0) {
    return (
      <p className="panel-empty">
        Selecione um clipe com fala e use <strong>Áudio → Fala → Transcrever</strong>. O texto aparece aqui.
      </p>
    );
  }

  const low = range ? Math.min(range.from, range.to) : -1;
  const high = range ? Math.max(range.from, range.to) : -1;
  const pick = (index: number, extend: boolean) => {
    setRange(extend && range ? { ...range, to: index } : { from: index, to: index });
    if (!extend) player.seek(words[index]!.at);
  };
  const spoken = (word: PlacedWord) => playhead >= word.at && playhead < word.until;

  return (
    <div className="transcript">
      <div className="transcript-tools">
        <span>{range ? `${high - low + 1} selecionada(s)` : "Clique, e Shift+clique para um trecho"}</span>
        <button
          type="button"
          disabled={!range}
          data-testid="transcript-delete"
          title="Corta esse trecho do vídeo"
          onClick={() => {
            cutWords(words.slice(low, high + 1));
            setRange(null);
          }}
        >
          Cortar trecho
        </button>
      </div>
      <p className="transcript-text">
        {words.map((word, index) => (
          <button
            key={`${word.segmentId}:${word.start}`}
            type="button"
            className={`word${index >= low && index <= high ? " is-picked" : ""}${spoken(word) ? " is-spoken" : ""}`}
            title="Dois cliques para corrigir"
            data-testid="word"
            onClick={(event) => pick(index, event.shiftKey)}
            onDoubleClick={() => {
              const text = window.prompt("Corrigir palavra", word.text)?.trim();
              if (text && text !== word.text) fixWord(word, text);
            }}
          >
            {word.text}
          </button>
        ))}
      </p>
    </div>
  );
}

/** Every text on the timeline as an editable list, with find and replace across all of them. */
function CaptionList() {
  const project = useEditor((current) => current.project);
  const [find, setFind] = useState("");
  const [replacement, setReplacement] = useState("");
  const clips = subtitleClips(project);
  if (clips.length === 0) {
    return <p className="panel-empty">Ainda não há legendas. Crie em <strong>Áudio → Fala</strong> ou importe um SRT.</p>;
  }
  return (
    <div className="transcript">
      <div className="caption-tools">
        <input aria-label="Procurar" placeholder="Procurar" data-testid="caption-find" value={find} onChange={(event) => setFind(event.target.value)} />
        <input aria-label="Trocar por" placeholder="Trocar por" data-testid="caption-replace" value={replacement} onChange={(event) => setReplacement(event.target.value)} />
        <button
          type="button"
          disabled={!find}
          data-testid="caption-replace-all"
          onClick={() => edit((current) => replaceInTexts(current, find, replacement).project)}
        >
          Trocar
        </button>
      </div>
      <ul className="caption-list">
        {clips.map(({ segment, material }) => (
          <li key={segment.id} className="caption-row">
            <button
              type="button"
              title="Ir para esta legenda"
              onClick={() => {
                setState({ selection: segment.id, alsoSelected: [] });
                player.seek(Math.min(segment.target.start, projectDuration(project)));
              }}
            >
              {formatTime(segment.target.start, project.fps).slice(0, 5)}
            </button>
            <textarea
              aria-label="Texto da legenda"
              data-testid="caption-text"
              rows={1}
              value={material.text}
              onChange={(event) => {
                const text = event.target.value;
                edit((current) => updateMaterial(current, material.id, { text }), `caption:${material.id}`);
              }}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}

export function SpeechTab() {
  const [view, setView] = useState<"transcript" | "captions">("transcript");
  return (
    <>
      <div className="bin-subtabs subtabs" role="tablist" aria-label="Fala">
        <button type="button" role="tab" className="subtab" aria-selected={view === "transcript"} onClick={() => setView("transcript")}>
          Transcrição
        </button>
        <button
          type="button"
          role="tab"
          className="subtab"
          aria-selected={view === "captions"}
          data-testid="view-captions"
          onClick={() => setView("captions")}
        >
          Legendas
        </button>
      </div>
      {view === "transcript" ? <Transcript /> : <CaptionList />}
    </>
  );
}
