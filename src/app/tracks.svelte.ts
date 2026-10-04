// past positions (vessel trails) sourced from the @signalk/tracks-plugin track
// api. that plugin is a shared signal k resource: it already accumulates one
// point per configured time resolution and keeps a sliding window, so we get
// history immediately at startup instead of building our own buffer from empty,
// and the points are equally spaced by time as IMO SN.1/Circ.243 requires.

import {
  DEFAULT_TRACK_RESOLUTION,
  TRACKS_REFRESH_INTERVAL,
} from "../engine/constants";
import type { Tracks } from "../types";
import { getTrackResolution, getTracks } from "./utils/api";

// a plain object, not $state: only the map's update loop reads it, and a deep $state
// proxy over thousands of coordinate arrays cost hundreds of milliseconds per tick
// (and hundreds of MB) for reactivity nothing used
export const tracksState: {
  tracks: Tracks;
  available: boolean;
  resolution: number;
} = {
  tracks: {},
  available: false,
  resolution: DEFAULT_TRACK_RESOLUTION,
};

let timeoutId: ReturnType<typeof setTimeout> | undefined;

// read once: the plugin's resolution only changes when it is reconfigured, which
// restarts the plugin anyway. falls back to the plugin default when the config is
// not readable (a non-admin session cannot see it).
async function refreshResolution() {
  try {
    tracksState.resolution =
      (await getTrackResolution()) ?? DEFAULT_TRACK_RESOLUTION;
  } catch {
    tracksState.resolution = DEFAULT_TRACK_RESOLUTION;
  }
}

export async function refreshTracks() {
  try {
    tracksState.tracks = await getTracks();
    tracksState.available = true;
  } catch {
    // the tracks plugin is optional - trails are simply absent without it
    tracksState.tracks = {};
    tracksState.available = false;
  }
}

let running = false;
// bumped on every start and stop. a loop still awaiting its fetch when the loop is
// stopped and restarted must not carry on alongside the new one - the running flag
// alone cannot tell them apart
let generation = 0;

export function startTracksLoop() {
  if (running) return;
  running = true;
  const gen = ++generation;
  refreshResolution();
  tracksLoop(gen);
}

// wait for each poll before scheduling the next, so a download slower than the
// interval cannot overlap the next one and land out of order
async function tracksLoop(gen: number) {
  await refreshTracks();
  if (!running || gen !== generation) return;
  timeoutId = setTimeout(() => tracksLoop(gen), TRACKS_REFRESH_INTERVAL);
}

export function stopTracksLoop() {
  running = false;
  generation++;
  clearTimeout(timeoutId);
  timeoutId = undefined;
}
