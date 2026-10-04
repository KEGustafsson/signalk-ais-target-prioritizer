import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const post = vi.fn();
const put = vi.fn();
vi.mock("ky", () => ({
  default: Object.assign(vi.fn(), {
    post: (...a: unknown[]) => post(...a),
    put: (...a: unknown[]) => put(...a),
  }),
}));

import { pushAlarmIsMuted, pushMuteAllAlarms } from "../src/app/utils/api";
import type { Context } from "@signalk/server-api";

const CTX = "vessels.urn:mrn:imo:mmsi:230941380" as Context;

beforeEach(() => {
  post.mockReset().mockResolvedValue(undefined);
  put.mockReset().mockResolvedValue(undefined);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("pushMuteAllAlarms", () => {
  it("POSTs, so a cross-site GET cannot mute alarms", async () => {
    await pushMuteAllAlarms();
    expect(post).toHaveBeenCalledWith(
      expect.stringMatching(/\/muteAllAlarms$/),
      expect.anything(),
    );
  });

  it("logs a failure rather than rejecting", async () => {
    post.mockRejectedValue(new Error("down"));
    await expect(pushMuteAllAlarms()).resolves.toBeUndefined();
    expect(console.warn).toHaveBeenCalled();
  });
});

describe("pushAlarmIsMuted", () => {
  it("PUTs the context and flag as json", async () => {
    await pushAlarmIsMuted(CTX, true);
    expect(put).toHaveBeenCalledWith(
      expect.stringMatching(/\/setAlarmIsMuted$/),
      expect.objectContaining({ json: { context: CTX, alarmIsMuted: true } }),
    );
  });

  it("logs a failure rather than rejecting", async () => {
    put.mockRejectedValue(new Error("404"));
    await expect(pushAlarmIsMuted(CTX, false)).resolves.toBeUndefined();
    expect(console.warn).toHaveBeenCalled();
  });
});
