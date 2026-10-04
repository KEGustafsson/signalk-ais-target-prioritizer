import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import createPlugin from "../src/plugin/index.svelte";
import { createVessel, vessels } from "../src/engine/vessels.svelte";
import {
  collisionProfiles,
  resetCollisionProfiles,
} from "../src/engine/collisionProfiles.svelte";
import {
  KNOTS_PER_M_PER_S,
  NO_GPS_FIX_WARNING,
  PUBLISH_MAX_INTERVAL,
  TARGET_MAX_AGE,
} from "../src/engine/constants";
import type { Context, Plugin, ServerAPI } from "@signalk/server-api";
import type { Vessel } from "../src/types";

// drives the plugin source (not the built bundle) against a fake signal k app

const SELF = "vessels.urn:mrn:signalk:uuid:self" as Context;
const ctx = (id: string) => `vessels.urn:mrn:imo:mmsi:${id}` as Context;
const NORTH = 0;
const SOUTH = Math.PI;
const knots = (kn: number) => kn / KNOTS_PER_M_PER_S;
const nmNorth = (nm: number) => nm / 60;
const TICK = 3_000; // default updateIntervalDelay, in ms

type Handler = (
  req: { body?: unknown; params?: Record<string, string> },
  res: FakeRes,
) => void;

interface FakeRes {
  statusCode: number;
  body: unknown;
  status: (code: number) => FakeRes;
  json: (body?: unknown) => FakeRes;
  end: () => FakeRes;
}

function fakeRes(): FakeRes {
  const res: FakeRes = {
    statusCode: 200,
    body: undefined,
    status(code) {
      res.statusCode = code;
      return res;
    },
    json(body) {
      res.body = body;
      return res;
    },
    end() {
      return res;
    },
  };
  return res;
}

let dataDir: string;
let messages: { context?: string; path: string; value: unknown }[];
let routes: Record<string, Handler>;
let skTree: Record<string, unknown>;
let plugin: Plugin;
let pluginErrors: string[];
let pluginStatuses: string[];

function createApp() {
  return {
    debug: () => {},
    error: () => {},
    selfContext: SELF,
    getDataDirPath: () => dataDir,
    subscriptionmanager: { subscribe: () => {} },
    handleMessage: (
      _id: string,
      delta: {
        context?: string;
        updates: { values: { path: string; value: unknown }[] }[];
      },
    ) => {
      for (const u of delta.updates)
        for (const v of u.values)
          messages.push({
            context: delta.context,
            path: v.path,
            value: v.value,
          });
    },
    setPluginStatus: (s: string) => pluginStatuses.push(s),
    setPluginError: (s: string) => pluginErrors.push(s),
    getPath: (p: string) => skTree[p],
    getSelfPath: (p: string) => skTree[`self.${p}`],
  } as unknown as ServerAPI;
}

function registerRoutes() {
  routes = {};
  const add =
    (method: string) =>
    (route: string, handler: Handler): void => {
      routes[`${method} ${route}`] = handler;
    };
  plugin.registerWithRouter?.({
    get: add("GET"),
    put: add("PUT"),
    post: add("POST"),
  } as never);
}

function call(route: string, body?: unknown) {
  const res = fakeRes();
  const handler = routes[route];
  if (!handler) throw new Error(`no route ${route}`);
  handler({ body, params: {} }, res);
  return res;
}

function put(context: Context, overrides: Partial<Vessel> = {}) {
  vessels[context] = {
    ...createVessel(context),
    mmsi: context.slice(-9),
    latitude: 0,
    longitude: 0,
    sog: 0,
    cog: NORTH,
    lastSeenDate: new Date(),
    ...overrides,
  };
  return vessels[context];
}

// a target 1 NM north closing head on at 10 kn - inside the offshore danger cpa/tcpa
function putCollisionCourse(id: string, overrides: Partial<Vessel> = {}) {
  return put(ctx(id), {
    latitude: nmNorth(1),
    sog: knots(10),
    cog: SOUTH,
    ...overrides,
  });
}

const notificationsFor = (context?: string) =>
  messages.filter(
    (m) =>
      m.path === "notifications.navigation.closestApproach" &&
      m.context === context,
  );
const closestApproachFor = (context: string) =>
  messages.filter(
    (m) => m.path === "navigation.closestApproach" && m.context === context,
  );

// a plain copy of the reactive store
const snapshot = () => JSON.parse(JSON.stringify(collisionProfiles));

function start(options: Record<string, unknown> = {}) {
  plugin.start(options, () => {});
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aistp-"));
  messages = [];
  skTree = {};
  pluginErrors = [];
  pluginStatuses = [];
  for (const key of Object.keys(vessels)) delete vessels[key as Context];
  resetCollisionProfiles();
  plugin = createPlugin(createApp());
  registerRoutes();
});

afterEach(() => {
  plugin.stop();
  vi.useRealTimers();
  vi.restoreAllMocks();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("alarm notifications", () => {
  it("raises an alarm once, not on every tick", () => {
    put(SELF);
    putCollisionCourse("111111111");
    start();
    vi.advanceTimersByTime(TICK * 3);

    const sent = notificationsFor(ctx("111111111"));
    expect(sent).toHaveLength(1);
    expect(sent[0].value).toMatchObject({ state: "alarm" });
  });

  it("clears the alarm once the target no longer qualifies", () => {
    put(SELF);
    const target = putCollisionCourse("111111111");
    start();

    target.cog = NORTH; // now opening
    vi.advanceTimersByTime(TICK);

    const sent = notificationsFor(ctx("111111111"));
    expect(sent.map((m) => (m.value as { state: string }).state)).toEqual([
      "alarm",
      "normal",
    ]);
  });

  it("clears the alarm of a target that ages out of the vessel list", () => {
    put(SELF);
    const target = putCollisionCourse("111111111");
    start();

    target.lastSeenDate = new Date(Date.now() - (TARGET_MAX_AGE + 60) * 1000);
    vi.advanceTimersByTime(TICK);

    expect(vessels[ctx("111111111")]).toBeUndefined();
    const sent = notificationsFor(ctx("111111111"));
    expect(sent.at(-1)?.value).toMatchObject({ state: "normal" });
  });

  it("does not send a clear for a target that never alarmed", () => {
    put(SELF);
    put(ctx("222222222"), { latitude: nmNorth(20) });
    start();
    vi.advanceTimersByTime(TICK * 2);

    expect(notificationsFor(ctx("222222222"))).toHaveLength(0);
  });

  it("clears an alarm left standing by an earlier run of the plugin", () => {
    put(SELF);
    put(ctx("222222222"), { latitude: nmNorth(20) });
    skTree[
      `${ctx("222222222")}.notifications.navigation.closestApproach.value.state`
    ] = "alarm";
    start();

    expect(notificationsFor(ctx("222222222")).at(-1)?.value).toMatchObject({
      state: "normal",
    });
  });

  it("leaves an own-vessel alarm it did not raise alone", () => {
    put(SELF);
    skTree["self.notifications.navigation.closestApproach.value.state"] =
      "alarm";
    start();
    vi.advanceTimersByTime(TICK);

    expect(notificationsFor(undefined)).toHaveLength(0);
  });

  it("clears its alarms when the plugin stops", () => {
    put(SELF);
    putCollisionCourse("111111111");
    start();
    plugin.stop();

    expect(notificationsFor(ctx("111111111")).at(-1)?.value).toMatchObject({
      state: "normal",
    });
  });

  it("raises the lost gps alarm once, and clears it when gps returns", () => {
    const self = put(SELF, {
      lastSeenDate: new Date(Date.now() - (NO_GPS_FIX_WARNING + 5) * 1000),
    });
    start();
    vi.advanceTimersByTime(TICK * 2);

    expect(notificationsFor(undefined)).toHaveLength(1);
    expect(notificationsFor(undefined)[0].value).toMatchObject({
      state: "alarm",
    });
    expect(pluginErrors.length).toBeGreaterThan(0);

    self.lastSeenDate = new Date();
    vi.advanceTimersByTime(TICK);

    expect(notificationsFor(undefined).at(-1)?.value).toMatchObject({
      state: "normal",
    });
  });

  it("waits quietly for a first own-vessel position", () => {
    put(SELF, { latitude: null, longitude: null, lastSeenDate: null });
    putCollisionCourse("111111111");
    start();

    expect(messages).toHaveLength(0);
    expect(pluginStatuses.at(-1)).toMatch(/waiting/i);
  });

  it("publishes no notifications when alarm publishing is off", () => {
    put(SELF);
    putCollisionCourse("111111111");
    start({ enableAlarmPublishing: false });

    expect(notificationsFor(ctx("111111111"))).toHaveLength(0);
  });
});

describe("target data publishing", () => {
  it("skips a target whose data has not moved, until the refresh interval", () => {
    put(SELF);
    put(ctx("333333333"), { latitude: nmNorth(5) }); // stationary
    start();
    vi.advanceTimersByTime(TICK * 3);

    expect(closestApproachFor(ctx("333333333"))).toHaveLength(1);

    vi.advanceTimersByTime(PUBLISH_MAX_INTERVAL);
    expect(closestApproachFor(ctx("333333333"))).toHaveLength(2);
  });

  it("republishes a target as soon as it moves on", () => {
    put(SELF);
    const target = put(ctx("333333333"), { latitude: nmNorth(5) });
    start();

    target.latitude = nmNorth(4);
    vi.advanceTimersByTime(TICK);

    expect(closestApproachFor(ctx("333333333"))).toHaveLength(2);
  });

  it("keeps the signal k closestApproach field names", () => {
    put(SELF);
    putCollisionCourse("111111111");
    start();

    expect(closestApproachFor(ctx("111111111"))[0].value).toHaveProperty(
      "distance",
    );
    expect(closestApproachFor(ctx("111111111"))[0].value).toHaveProperty(
      "timeTo",
    );
  });
});

describe("routes", () => {
  it("only mutes through POST and PUT", () => {
    expect(routes["GET /muteAllAlarms"]).toBeUndefined();
    expect(routes["POST /muteAllAlarms"]).toBeDefined();
    expect(routes["PUT /setAlarmIsMuted"]).toBeDefined();
  });

  it("mutes a vessel by context", () => {
    put(SELF);
    put(ctx("111111111"));
    const res = call("PUT /setAlarmIsMuted", {
      context: ctx("111111111"),
      alarmIsMuted: true,
    });
    expect(res.statusCode).toBe(200);
    expect(vessels[ctx("111111111")].alarmIsMuted).toBe(true);
  });

  it("rejects a malformed mute request", () => {
    put(ctx("111111111"));
    expect(call("PUT /setAlarmIsMuted", {}).statusCode).toBe(400);
    expect(
      call("PUT /setAlarmIsMuted", {
        context: ctx("111111111"),
        alarmIsMuted: "true",
      }).statusCode,
    ).toBe(400);
    expect(
      call("PUT /setAlarmIsMuted", {
        context: ctx("999999999"),
        alarmIsMuted: true,
      }).statusCode,
    ).toBe(404);
    expect(
      call("PUT /setAlarmIsMuted", { context: "toString", alarmIsMuted: true })
        .statusCode,
    ).toBe(404);
  });

  it("refuses invalid collision profiles and keeps the current ones", () => {
    const before = snapshot();
    const res = call("PUT /saveCollisionProfiles", {
      ...before,
      offshore: { warning: { cpa: "lots" } },
    });
    expect(res.statusCode).toBe(400);
    expect(snapshot()).toEqual(before);
  });

  it("saves only the known profile fields", () => {
    const body = {
      ...snapshot(),
      current: "harbor",
      extra: "junk",
    };
    const res = call("PUT /saveCollisionProfiles", body);
    expect(res.statusCode).toBe(200);

    const saved = JSON.parse(
      fs.readFileSync(path.join(dataDir, "collisionProfiles.json"), "utf8"),
    );
    expect(saved.current).toBe("harbor");
    expect(saved).not.toHaveProperty("extra");
  });
});

describe("loading collision profiles", () => {
  it("falls back to the defaults on a corrupt file, without overwriting it", () => {
    const file = path.join(dataDir, "collisionProfiles.json");
    fs.writeFileSync(file, "{ not json");
    collisionProfiles.current = "anchor";

    expect(() => start()).not.toThrow();
    expect(collisionProfiles.current).toBe("offshore");
    expect(fs.readFileSync(file, "utf8")).toBe("{ not json");
  });

  it("falls back to the defaults on an invalid file", () => {
    fs.writeFileSync(
      path.join(dataDir, "collisionProfiles.json"),
      JSON.stringify({ current: "nowhere" }),
    );
    start();
    expect(collisionProfiles.current).toBe("offshore");
  });

  it("loads a valid file", () => {
    fs.writeFileSync(
      path.join(dataDir, "collisionProfiles.json"),
      JSON.stringify({
        ...snapshot(),
        current: "coastal",
      }),
    );
    start();
    expect(collisionProfiles.current).toBe("coastal");
  });

  it("writes the defaults on first start", () => {
    start();
    expect(fs.existsSync(path.join(dataDir, "collisionProfiles.json"))).toBe(
      true,
    );
  });
});
