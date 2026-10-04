import ky from "ky";
import { name as PLUGIN_ID } from "../../../package.json";
import type { Chart, CollisionProfiles, Tracks, Vessel } from "../../types";
import { isValidCollisionProfiles } from "../../engine/validateCollisionProfiles";
import type { Context } from "@signalk/server-api";

// retrieves configuration data from signal k server via plugin. a failed request
// throws rather than returning nothing: the caller must be able to tell "could not
// load" apart from "loaded, but invalid", or it overwrites the saved profiles
export async function loadCollisionProfiles() {
  console.log("loading collision profiles");
  const data: unknown = await ky(
    `/plugins/${PLUGIN_ID}/loadCollisionProfiles`,
    {
      credentials: "include",
    },
  ).json();
  console.log("loaded collision profiles", data);
  return data;
}

// validates and then saves configuration data to signal k server via plugin
export async function saveCollisionProfiles(data: CollisionProfiles) {
  console.log("saving collision profiles", data);
  try {
    if (!isValidCollisionProfiles(data)) {
      return { success: false, reason: "invalid-data" };
    }
    await ky.put(`/plugins/${PLUGIN_ID}/saveCollisionProfiles`, {
      credentials: "include",
      json: data,
    });
    return { success: true };
  } catch (e) {
    console.error(e);
    return { success: false, reason: "request-failed", error: e };
  }
}

export async function getPmtiles() {
  const data: string[] = await ky("/signalk/pmtiles", {
    credentials: "include",
  }).json();
  return data;
}

export async function getCharts() {
  const data: Chart[] = await ky("/signalk/v2/api/resources/charts", {
    credentials: "include",
  }).json();
  console.log(data);
  return data;
}

export async function getSelf() {
  const data = await ky("/signalk/v1/api/vessels/self", {
    credentials: "include",
  }).json();
  return data;
}

// past positions from the optional @signalk/tracks-plugin. no radius/bbox filter:
// the plugin's own maxRadius config governs how much it returns, and we only draw
// tracks for vessels we already know about. rejects with a 404 when not enabled.
export async function getTracks() {
  const data: Tracks = await ky("/signalk/v1/api/tracks", {
    credentials: "include",
  }).json();
  return data;
}

// the tracks plugin's configured milliseconds-per-point. we need it to know how
// far a vessel travels between dots, and reading it means the trail thinning
// follows whatever the plugin is actually set to.
export async function getTrackResolution() {
  const plugins: {
    id: string;
    data?: { configuration?: { resolution?: number } };
  }[] = await ky("/skServer/plugins", { credentials: "include" }).json();
  const resolution = plugins.find((p) => p.id === "tracks")?.data?.configuration
    ?.resolution;
  return typeof resolution === "number" ? resolution : undefined;
}

export async function getVessels() {
  const data: Vessel[] = await ky(`/plugins/${PLUGIN_ID}/getVessels`, {
    credentials: "include",
  }).json();
  return data;
}

export async function getMutedVessels() {
  const data: Vessel[] = await ky(`/plugins/${PLUGIN_ID}/getMutedVessels`, {
    credentials: "include",
  }).json();
  return data;
}

// the mute pushes are fire-and-forget from the ui: the local mute has already been
// applied, so a failure here (plugin not running, or not tracking that vessel
// because its own calculations are off) is logged rather than left unhandled
export async function pushMuteAllAlarms() {
  try {
    await ky.post(`/plugins/${PLUGIN_ID}/muteAllAlarms`, {
      credentials: "include",
      // the plugin only accepts state changes with a json body (csrf guard)
      json: {},
    });
  } catch (e) {
    console.warn("unable to push muteAllAlarms to the plugin", e);
  }
}

export async function pushAlarmIsMuted(
  context: Context,
  alarmIsMuted: boolean,
) {
  try {
    await ky.put(`/plugins/${PLUGIN_ID}/setAlarmIsMuted`, {
      credentials: "include",
      json: { context, alarmIsMuted },
    });
  } catch (e) {
    console.warn("unable to push alarmIsMuted to the plugin", e);
  }
}
