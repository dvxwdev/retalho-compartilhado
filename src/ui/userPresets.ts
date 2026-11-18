import type { TextPreset } from "../core/textPresets";

const STORAGE_KEY = "retalho.textPresets";

/** Saved styles are a convenience, so a browser that blocks storage just starts empty. */
export function loadUserPresets(): TextPreset[] {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    return Array.isArray(stored) ? (stored as TextPreset[]) : [];
  } catch {
    return [];
  }
}

export function storeUserPresets(presets: TextPreset[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(presets));
  } catch {
    // Without storage the styles still work until the page closes.
  }
}
