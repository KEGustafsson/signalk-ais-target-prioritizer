import { describe, it, expect } from "vitest";

import { hasTargetDataChanged } from "../src/plugin/publishing";
import { PUBLISH_THRESHOLDS } from "../src/engine/constants";

const base = {
  cpa: 1000,
  tcpa: 600,
  range: 5000,
  bearing: 90,
  alarmType: null,
  alarmState: null,
};

describe("hasTargetDataChanged", () => {
  it("is false for identical data", () => {
    expect(hasTargetDataChanged(base, { ...base })).toBe(false);
  });

  it("ignores movement inside every threshold", () => {
    expect(
      hasTargetDataChanged(base, {
        ...base,
        cpa: base.cpa + PUBLISH_THRESHOLDS.CPA_METERS,
        tcpa: base.tcpa - PUBLISH_THRESHOLDS.TCPA_SECONDS,
        range: base.range + PUBLISH_THRESHOLDS.RANGE_METERS,
        bearing: base.bearing + PUBLISH_THRESHOLDS.BEARING_DEGREES,
      }),
    ).toBe(false);
  });

  it.each([
    ["cpa", PUBLISH_THRESHOLDS.CPA_METERS],
    ["tcpa", PUBLISH_THRESHOLDS.TCPA_SECONDS],
    ["range", PUBLISH_THRESHOLDS.RANGE_METERS],
    ["bearing", PUBLISH_THRESHOLDS.BEARING_DEGREES],
  ] as const)("notices %s moving past its threshold", (key, threshold) => {
    expect(
      hasTargetDataChanged(base, { ...base, [key]: base[key] + threshold + 1 }),
    ).toBe(true);
  });

  it("notices a value appearing or disappearing", () => {
    expect(hasTargetDataChanged(base, { ...base, cpa: undefined })).toBe(true);
    expect(
      hasTargetDataChanged({ ...base, tcpa: undefined }, { ...base }),
    ).toBe(true);
  });

  it("treats two missing values as unchanged", () => {
    const none = { ...base, cpa: undefined, tcpa: undefined };
    expect(hasTargetDataChanged(none, { ...none })).toBe(false);
  });

  it("notices a change of alarm state or type", () => {
    expect(hasTargetDataChanged(base, { ...base, alarmState: "danger" })).toBe(
      true,
    );
    expect(hasTargetDataChanged(base, { ...base, alarmType: "cpa" })).toBe(
      true,
    );
  });

  it("measures bearing the short way round through north", () => {
    expect(
      hasTargetDataChanged(
        { ...base, bearing: 359.8 },
        { ...base, bearing: 0.2 },
      ),
    ).toBe(false);
    expect(
      hasTargetDataChanged({ ...base, bearing: 358 }, { ...base, bearing: 1 }),
    ).toBe(true);
  });
});
