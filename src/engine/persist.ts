import type { Project } from "../core/model";

const DATABASE = "retalho";
const PROJECT_STORE = "project";
const MEDIA_STORE = "media";
/** Points to the project open last. Older saves kept the project itself here. */
const CURRENT = "current";

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(PROJECT_STORE);
      request.result.createObjectStore(MEDIA_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function run<T>(
  store: string,
  mode: IDBTransactionMode,
  action: (objects: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const database = await open();
  try {
    return await new Promise((resolve, reject) => {
      const request = action(database.transaction(store, mode).objectStore(store));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally {
    database.close();
  }
}

export interface SavedProject {
  id: string;
  name: string;
  /** When it was last saved. */
  savedAt: number;
}

export async function saveProject(project: Project): Promise<void> {
  await run(PROJECT_STORE, "readwrite", (objects) => objects.put({ ...project, savedAt: Date.now() }, project.id));
  await run(PROJECT_STORE, "readwrite", (objects) => objects.put(project.id, CURRENT));
}

export async function loadProject(id?: string): Promise<Project | undefined> {
  const pointer = id ?? (await run<string | Project | undefined>(PROJECT_STORE, "readonly", (objects) => objects.get(CURRENT)));
  if (pointer && typeof pointer === "object") return pointer;
  return pointer ? run<Project | undefined>(PROJECT_STORE, "readonly", (objects) => objects.get(pointer)) : undefined;
}

/** Every project in this browser, most recent first. */
export async function listProjects(): Promise<SavedProject[]> {
  const all = await run<(Project & { savedAt?: number })[]>(PROJECT_STORE, "readonly", (objects) => objects.getAll());
  return all
    .filter((item) => item && typeof item === "object" && item.format === "retalho")
    .map(({ id, name, savedAt }) => ({ id, name, savedAt: savedAt ?? 0 }))
    .sort((a, b) => b.savedAt - a.savedAt);
}

export function deleteSavedProject(id: string): Promise<undefined> {
  return run(PROJECT_STORE, "readwrite", (objects) => objects.delete(id));
}

export function saveMedia(id: string, blob: Blob): Promise<IDBValidKey> {
  return run(MEDIA_STORE, "readwrite", (objects) => objects.put(blob, id));
}

export function loadMedia(id: string): Promise<Blob | undefined> {
  return run(MEDIA_STORE, "readonly", (objects) => objects.get(id));
}

export function deleteMedia(id: string): Promise<undefined> {
  return run(MEDIA_STORE, "readwrite", (objects) => objects.delete(id));
}

/** Ids of every stored file, to find those no project uses any more. */
export function storedMediaIds(): Promise<IDBValidKey[]> {
  return run(MEDIA_STORE, "readonly", (objects) => objects.getAllKeys());
}
