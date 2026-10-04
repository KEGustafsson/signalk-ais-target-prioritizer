// change detection for the derived data the plugin publishes to signal k

import { isValidNumber } from "../engine/calculations";
import { PUBLISH_THRESHOLDS } from "../engine/constants";

export interface PublishedTargetData {
  cpa?: number;
  tcpa?: number;
  range?: number;
  bearing?: number;
  alarmType?: string | null;
  alarmState?: string | null;
}

// is the gap between what signal k holds and what we have now worth a delta?
export function hasTargetDataChanged(
  previous: PublishedTargetData,
  current: PublishedTargetData,
): boolean {
  if (
    previous.alarmState !== current.alarmState ||
    previous.alarmType !== current.alarmType
  ) {
    return true;
  }

  const moved = (
    a: number | undefined,
    b: number | undefined,
    threshold: number,
    wrap?: number,
  ) => {
    // appearing or disappearing is always a change - e.g. a cpa going away once
    // the target has passed
    if (isValidNumber(a) !== isValidNumber(b)) return true;
    if (!isValidNumber(a) || !isValidNumber(b)) return false;
    let diff = Math.abs(a - b);
    if (wrap) diff = Math.min(diff, wrap - diff);
    return diff > threshold;
  };

  return (
    moved(previous.cpa, current.cpa, PUBLISH_THRESHOLDS.CPA_METERS) ||
    moved(previous.tcpa, current.tcpa, PUBLISH_THRESHOLDS.TCPA_SECONDS) ||
    moved(previous.range, current.range, PUBLISH_THRESHOLDS.RANGE_METERS) ||
    moved(
      previous.bearing,
      current.bearing,
      PUBLISH_THRESHOLDS.BEARING_DEGREES,
      360,
    )
  );
}
