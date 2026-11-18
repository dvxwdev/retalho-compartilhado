import { useSyncExternalStore } from "react";
import { createProject, findSegment, type Project, type Us } from "../core/model";
import type { CopiedSegment } from "../core/ops";
import { audioPlan } from "../core/resolve";
import { audioIsReady, prepareAudio } from "../engine/audioJobs";
import { Player } from "../engine/player";

const HISTORY_LIMIT = 100;
/** Waits for a drag to settle, so a trim does not process every position it passes through. */
const AUDIO_WORK_DELAY_MS = 300;
const COALESCE_WINDOW_MS = 800;

export interface EditorState {
  project: Project;
  selection: string | null;
  /** Other clips selected along with the main one. */
  alsoSelected: string[];
  playhead: Us;
  playing: boolean;
  /** Timeline pixels per second. */
  zoom: number;
  snapping: boolean;
  canUndo: boolean;
  canRedo: boolean;
  /** Bumped when decoded media changes, so covers and waveforms redraw. */
  mediaRevision: number;
  notice: { text: string; details?: string[] } | null;
  clipboard: CopiedSegment | null;
  recording: boolean;
  /** The open category of the properties panel. */
  panelTab: string;
  /** The open section inside each category that has sections. */
  panelSection: Record<string, string>;
  /** Audio work running in the background. */
  audioBusy: number;
  /** Edits with light copies of large videos. */
  lightPreview: boolean;
  /** A long job the user started, with its progress from 0 to 1 when known. */
  task: { label: string; progress: number | null } | null;
}

let state: EditorState = {
  project: createProject(),
  selection: null,
  alsoSelected: [],
  playhead: 0,
  playing: false,
  zoom: 80,
  snapping: true,
  canUndo: false,
  canRedo: false,
  mediaRevision: 0,
  notice: null,
  clipboard: null,
  recording: false,
  panelTab: "position",
  panelSection: {},
  audioBusy: 0,
  lightPreview: false,
  task: null,
};

const listeners = new Set<() => void>();
const past: Project[] = [];
const future: Project[] = [];
let lastEdit: { key: string; at: number } | null = null;

export function getState(): EditorState {
  return state;
}

export function setState(patch: Partial<EditorState>): void {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useEditor<T>(selector: (current: EditorState) => T): T {
  return useSyncExternalStore(subscribe, () => selector(state));
}

export const player = new Player({
  project: () => state.project,
  playhead: () => state.playhead,
  setPlayhead: (playhead) => setState({ playhead }),
  setPlaying: (playing) => setState({ playing }),
});

function commit(project: Project): void {
  const selection =
    state.selection && findSegment(project, state.selection) ? state.selection : null;
  const alsoSelected = state.alsoSelected.filter((id) => findSegment(project, id));
  setState({ project, selection, alsoSelected, canUndo: past.length > 0, canRedo: future.length > 0 });
  player.projectChanged();
  scheduleSave();
  scheduleAudioWork();
}

let audioTimer = 0;

async function runAudioWork(): Promise<void> {
  const events = audioPlan(state.project, 0);
  if (audioIsReady(events)) return;
  setState({ audioBusy: state.audioBusy + 1 });
  const changed = await prepareAudio(events);
  setState({ audioBusy: state.audioBusy - 1 });
  if (changed && player.isPlaying) player.projectChanged();
}

function scheduleAudioWork(): void {
  window.clearTimeout(audioTimer);
  audioTimer = window.setTimeout(() => void runAudioWork(), AUDIO_WORK_DELAY_MS);
}

/**
 * Applies an edit. Edits sharing a key in quick succession form one undo step,
 * which is how a whole drag or slider movement undoes at once.
 */
export function edit(update: (project: Project) => Project, key?: string): void {
  const next = update(state.project);
  if (next === state.project) return;
  const now = performance.now();
  const merges = key && lastEdit?.key === key && now - lastEdit.at < COALESCE_WINDOW_MS;
  if (!merges) {
    past.push(state.project);
    if (past.length > HISTORY_LIMIT) past.shift();
  }
  future.length = 0;
  lastEdit = key ? { key, at: now } : null;
  commit(next);
}

export function undo(): void {
  const previous = past.pop();
  if (!previous) return;
  future.push(state.project);
  lastEdit = null;
  commit(previous);
}

export function redo(): void {
  const next = future.pop();
  if (!next) return;
  past.push(state.project);
  lastEdit = null;
  commit(next);
}

/** Replaces the project outright, for new, loaded and imported projects. */
export function resetProject(project: Project): void {
  past.length = 0;
  future.length = 0;
  lastEdit = null;
  player.pause();
  setState({ playhead: 0, selection: null });
  commit(project);
}

let saveTimer = 0;
let persist: ((project: Project) => void) | null = null;

export function onSave(handler: (project: Project) => void): void {
  persist = handler;
}

function scheduleSave(): void {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => persist?.(state.project), 400);
}
