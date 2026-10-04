// setInterval - runs calcs, updates vessels

import {
  AGE_OUT_OLD_TARGETS,
  DATA_REFRESH_INTERVAL,
  METERS_PER_NM,
  TARGET_MAX_AGE,
} from "./constants";
import {
  calcBearing,
  calcCpa,
  calcRange,
  calcProjection,
  calcVelocity,
  calcCpaLocation,
  calcPredictedLocation,
  calcLastSeenSecondsAgo,
  calcIsLost,
  calcIsValid,
  calcAlarms,
} from "./calculations";
import { deleteVessel, vessels, vesselsState } from "./vessels.svelte";
import { flushPendingUpdates } from "./ingestion.svelte";
import { getActiveCollisionProfile } from "./collisionProfiles.svelte";
import type { Vessel } from "../types";
import type { Context } from "@signalk/server-api";

const myVessel: Vessel | null = $derived(
  vesselsState.myVesselContext ? vessels[vesselsState.myVesselContext] : null,
);
const selectedVessel: Vessel | null = $derived(
  vesselsState.selectedVesselContext
    ? vessels[vesselsState.selectedVesselContext]
    : null,
);

let timeoutId: ReturnType<typeof setTimeout> | undefined;

export function start() {
  console.log("start updateVesselsLoop");
  updateVesselsLoop();
}

export function stop() {
  if (!timeoutId) return;
  clearTimeout(timeoutId);
  timeoutId = undefined;
}

function updateVesselsLoop() {
  updateVessels();
  timeoutId = setTimeout(updateVesselsLoop, DATA_REFRESH_INTERVAL);
}

// how long since we heard from a vessel. by its last position when it has one; a
// vessel that has only ever sent static data, or only invalid positions, goes by its
// last delta of any kind instead - otherwise it would never age out at all
function ageSeconds(vessel: Vessel): number {
  if (vessel.lastSeenSecondsAgo !== undefined) return vessel.lastSeenSecondsAgo;
  if (!vessel.lastUpdateDate) return 0;
  return (Date.now() - vessel.lastUpdateDate.getTime()) / 1000;
}

export function updateVessels() {
  flushPendingUpdates();

  // everything is relative to our own vessel, so there is nothing to work out until
  // its first delta arrives. that is a normal state - the first tick always lands
  // before any data - and each caller already reports it: the plugin as its status,
  // the webapp as an error once past warm-up. so no logging here.
  if (!myVessel) return;

  const myVelocity = calcVelocity(myVessel);

  for (const [context, vessel] of Object.entries(vessels) as [
    Context,
    Vessel,
  ][]) {
    // calculated from raw data:
    const projection = calcProjection(vessel, myVessel);
    const velocity = calcVelocity(vessel);
    const predictedLocation = calcPredictedLocation(vessel);
    const lastSeenSecondsAgo = calcLastSeenSecondsAgo(vessel);
    const isValid = calcIsValid(vessel);
    const cpaLocation =
      selectedVessel &&
      selectedVessel.tcpa !== undefined &&
      [
        vesselsState.myVesselContext,
        vesselsState.selectedVesselContext,
      ].includes(context)
        ? calcCpaLocation(vessel, selectedVessel.tcpa)
        : undefined;

    vessel.cpaLocation = cpaLocation;
    vessel.predictedLocation = predictedLocation;
    vessel.lastSeenSecondsAgo = lastSeenSecondsAgo;
    vessel.isValid = isValid;

    // calculated from derived data (for vessel other than our own - only):
    if (vessel.context !== vesselsState.myVesselContext) {
      const range = projection ? calcRange(projection) : undefined;
      const bearing = projection ? calcBearing(projection) : undefined;
      // FIXME: add option to cap CPA calc to the closest n targets
      // dont calculate cpa if range > 100 nm
      const { cpa = undefined, tcpa = undefined } =
        projection && range && range < 100 * METERS_PER_NM
          ? (calcCpa(projection, velocity, myVelocity) ?? {})
          : {};
      const isLost =
        lastSeenSecondsAgo !== undefined
          ? calcIsLost(lastSeenSecondsAgo)
          : false;
      const { alarmType, alarmState, order } =
        calcAlarms(
          getActiveCollisionProfile(),
          range,
          vessel.sog,
          cpa,
          tcpa,
          vessel.mmsi,
        ) ?? {};

      vessel.range = range;
      vessel.bearing = bearing;
      vessel.cpa = cpa;
      vessel.tcpa = tcpa;
      vessel.isLost = isLost;
      vessel.alarmType = alarmType;
      vessel.alarmState = alarmState;
      vessel.order = order;

      if (AGE_OUT_OLD_TARGETS && ageSeconds(vessel) > TARGET_MAX_AGE) {
        deleteVessel(vessel);
      }
    }
  } // end loop
}
