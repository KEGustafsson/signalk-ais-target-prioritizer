import { name as PLUGIN_ID } from "../../../package.json";

// every Signal K webapp and the server admin UI share one origin, so bare keys
// like "theme" collide across them
const PREFIX = `${PLUGIN_ID}.`;

// storage can be unavailable outright - blocked by browser policy, or a private
// window - and getItem then throws. these are read at module load, so a throw would
// stop the whole webapp from starting; carry on without persistence instead.
export function getStored(key: string): string | null {
  try {
    return localStorage.getItem(PREFIX + key);
  } catch {
    return null;
  }
}

export function setStored(key: string, value: string) {
  try {
    localStorage.setItem(PREFIX + key, value);
  } catch {
    // not persisted - nothing else to do
  }
}
