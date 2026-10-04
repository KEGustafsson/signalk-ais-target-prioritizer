import {
  type Plugin,
  type ServerAPI,
  type Context,
  type Path,
  type Unsubscribes,
} from "@signalk/server-api";
import fs from "node:fs";
import path from "node:path";
import * as npmPackage from "../../package.json";
import { queueVesselUpdates, subscription } from "../engine/ingestion.svelte";
import { updateVessels } from "../engine/refreshLoop.svelte";
import {
  deleteAllVessels,
  vessels,
  vesselsState,
} from "../engine/vessels.svelte";
import {
  collisionProfiles,
  resetCollisionProfiles,
  setCollisionProfiles,
} from "../engine/collisionProfiles.svelte";
import { muteAllAlarms, setAlarmIsMuted } from "../engine/alarms.svelte";
import {
  DEFAULT_ENABLE_ALARM_PUBLISHING,
  DEFAULT_ENABLE_DATA_PUBLISHING,
  DEFAULT_MAXIMUM_TARGET_RANGE,
  DEFAULT_UPDATE_INTERVAL_DELAY,
  METERS_PER_NM,
  NO_GPS_FIX_WARNING,
  PUBLISH_MAX_INTERVAL,
} from "../engine/constants";
import { calcIsValid } from "../engine/calculations";
import { hasTargetDataChanged, type PublishedTargetData } from "./publishing";
import { registerAssetEndpoints } from "./font-downloader";
import { schema } from "./schema";
import type { Vessel } from "../types";

const myVessel = $derived(
  vesselsState.myVesselContext ? vessels[vesselsState.myVesselContext] : null,
);

const STATUS_NORMAL = "normal";
const STATUS_WARN = "warn";
const STATUS_ALARM = "alarm";

const NOTIFICATION_PATH = "notifications.navigation.closestApproach" as Path;

// key for notifications raised on our own vessel (no context in the delta)
const OWN_VESSEL = "self";

interface Options {
  enabled: boolean;
  updateIntervalDelay: number;
  maximumTargetRange: number;
  enableDataPublishing: boolean;
  enableAlarmPublishing: boolean;
}

let timeoutId: NodeJS.Timeout | null;

let updateIntervalDelay: number;
let maximumTargetRange: number;
let enableDataPublishing: boolean;
let enableAlarmPublishing: boolean;

export default function (app: ServerAPI) {
  let unsubscribes: Unsubscribes = [];

  // what we last sent signal k: notification "state|message" per context, and the
  // derived data last published per target
  // plain maps on purpose: plugin bookkeeping, nothing renders from it
  // eslint-disable-next-line svelte/prefer-svelte-reactivity
  const notifications = new Map<Context | typeof OWN_VESSEL, string>();
  // eslint-disable-next-line svelte/prefer-svelte-reactivity
  const lastPublished = new Map<
    Context,
    { at: number; data: PublishedTargetData }
  >();

  const plugin: Plugin = {
    id: npmPackage.name,
    name: npmPackage.signalk.displayName,
    description: npmPackage.description,
    schema,
    start,
    stop,
  };

  function start(
    options: Options,
    _restart: (newConfiguration: object) => void,
  ) {
    app.debug(`*** Starting plugin ${plugin.id}`, { options });
    updateIntervalDelay =
      options.updateIntervalDelay ?? DEFAULT_UPDATE_INTERVAL_DELAY;
    maximumTargetRange =
      options.maximumTargetRange ?? DEFAULT_MAXIMUM_TARGET_RANGE;
    enableDataPublishing =
      options.enableDataPublishing ?? DEFAULT_ENABLE_DATA_PUBLISHING;
    enableAlarmPublishing =
      options.enableAlarmPublishing ?? DEFAULT_ENABLE_ALARM_PUBLISHING;
    loadCollisionProfiles();

    const selfContext = app.selfContext as Context;

    if (!selfContext) {
      app.error("ERROR - no context set for our vessel");
      throw new Error("ERROR - no context set for our vessel");
    }

    vesselsState.myVesselContext = selfContext;

    if (enableDataPublishing || enableAlarmPublishing) {
      enablePluginCpaCalculations();
    } else {
      // if plugin was stopped and started again with options set to not perform calculations, then clear out old targets
      deleteAllVessels();
    }
  }

  function stop() {
    app.debug(`Stopping plugin ${plugin.id}`);
    unsubscribes.forEach((f) => f());
    unsubscribes = [];
    stopUpdating();
    // nothing will be watching once we stop, so leave no alarm standing
    clearAllNotifications();
    lastPublished.clear();
    app.debug(`Stopped plugin ${plugin.id}`);
  }

  plugin.registerWithRouter = (router) => {
    router.get("/loadCollisionProfiles", (_req, res) => {
      app.debug("loadCollisionProfiles", collisionProfiles);
      res.json(collisionProfiles);
    });

    router.put("/saveCollisionProfiles", (req, res) => {
      const newCollisionProfiles = req.body;
      app.debug("saveCollisionProfiles", newCollisionProfiles);
      try {
        setCollisionProfiles(newCollisionProfiles);
      } catch {
        app.error("ERROR - not saving invalid new collision profiles");
        res.status(400).json({ error: "invalid collision profiles" });
        return;
      }
      try {
        saveCollisionProfiles();
      } catch (err) {
        app.error(`ERROR - could not save collision profiles: ${err}`);
        res.status(500).json({ error: "could not save collision profiles" });
        return;
      }
      res.json(collisionProfiles);
    });

    // state-changing routes are POST/PUT, not GET: a GET can be fired from any page
    // the user has open (an <img src>, a link prefetch) and would silently mute
    // collision alarms
    router.post("/muteAllAlarms", (_req, res) => {
      app.debug("muteAllAlarms");
      muteAllAlarms();
      res.json({ success: true });
    });

    router.put("/setAlarmIsMuted", (req, res) => {
      const { context, alarmIsMuted } = (req.body ?? {}) as {
        context?: unknown;
        alarmIsMuted?: unknown;
      };
      if (typeof context !== "string" || typeof alarmIsMuted !== "boolean") {
        res.status(400).json({
          error: "context (string) and alarmIsMuted (boolean) are required",
        });
        return;
      }
      if (!Object.hasOwn(vessels, context)) {
        res.status(404).json({ error: "vessel not found" });
        return;
      }
      app.debug("setting alarmIsMuted", context, alarmIsMuted);
      setAlarmIsMuted(context as Context, alarmIsMuted);
      res.json({ success: true });
    });

    router.get("/getVessels", (_req, res) => {
      app.debug("getVessels");
      res.json(vessels);
    });

    router.get("/getMutedVessels", (_req, res) => {
      app.debug("getMutedVessels");
      const mutedVessels = Object.values(vessels).filter(
        (vessel) => vessel.alarmIsMuted,
      );
      res.json(mutedVessels);
    });

    router.get("/getVessel/:context", (req, res) => {
      const context = req.params.context as Context;
      app.debug("getVessel", context);
      if (Object.hasOwn(vessels, context)) {
        res.json(vessels[context]);
      } else {
        res.status(404).end();
      }
    });

    registerAssetEndpoints(router);
  };

  // load configuration data from signal k server plugin configuration folder
  function loadCollisionProfiles() {
    const dataDirPath = app.getDataDirPath();
    const collisionProfilesPath = path.join(
      dataDirPath,
      "collisionProfiles.json",
    );

    if (!fs.existsSync(collisionProfilesPath)) {
      app.debug(
        "collisionProfiles.json not found, using defaultCollisionProfiles",
        collisionProfilesPath,
      );
      resetCollisionProfiles();
      saveCollisionProfiles();
      return;
    }

    // a corrupt or hand-edited file must not stop the plugin from starting - a
    // collision alarm that never runs is worse than one on default settings. the
    // file is left as it is, so the user can still recover their values from it;
    // the next save from the webapp replaces it.
    try {
      app.debug("Reading file", collisionProfilesPath);
      setCollisionProfiles(
        JSON.parse(fs.readFileSync(collisionProfilesPath).toString()),
      );
    } catch (err) {
      app.error(
        `Invalid ${collisionProfilesPath}, using the default collision profiles: ${err}`,
      );
      resetCollisionProfiles();
    }
  }

  // save configuration data to signal k server plugin configuration folder
  function saveCollisionProfiles() {
    app.debug("saving ", collisionProfiles);

    const dataDirPath = app.getDataDirPath();

    if (!fs.existsSync(dataDirPath)) {
      try {
        fs.mkdirSync(dataDirPath, { recursive: true });
      } catch (err) {
        app.error("Error creating dataDirPath");
        throw new Error("Error creating dataDirPath:", { cause: err });
      }
    }

    const collisionProfilesPath: string = path.join(
      dataDirPath,
      "collisionProfiles.json",
    );
    app.debug("Writing file", collisionProfilesPath);
    try {
      fs.writeFileSync(
        collisionProfilesPath,
        JSON.stringify(collisionProfiles, null, 2),
      );
    } catch (err) {
      app.error("Error writing collisionProfiles.json");
      throw new Error("Error writing collisionProfiles.json:", { cause: err });
    }
  }

  function enablePluginCpaCalculations() {
    app.subscriptionmanager.subscribe(
      subscription,
      unsubscribes,
      (subscriptionError) => {
        app.error(`Error:${subscriptionError}`);
      },
      (delta) => {
        if (delta.context) queueVesselUpdates(delta.context, delta.updates);
      },
    );

    updateVesselsLoop();
  }

  function updateVesselsLoop() {
    const start = performance.now();

    // one bad tick must not end the loop - nothing would ever restart it, and
    // every alarm would silently stop
    try {
      updateVessels();
      evaluateVessels();
    } catch (err) {
      app.error(`error updating vessels: ${err}`);
    }

    app.debug(
      `refreshed ${Object.keys(vessels).length - 1} targets in ${(performance.now() - start).toFixed(1)}ms`,
    );

    timeoutId = setTimeout(updateVesselsLoop, updateIntervalDelay * 1000);
  }

  function stopUpdating() {
    if (!timeoutId) return;
    clearTimeout(timeoutId);
    timeoutId = null;
  }

  function evaluateVessels() {
    try {
      if (!myVessel || !calcIsValid(myVessel)) {
        app.setPluginStatus("Waiting for own vessel GPS position");
        return;
      }

      if (
        myVessel.lastSeenSecondsAgo !== undefined &&
        myVessel.lastSeenSecondsAgo > NO_GPS_FIX_WARNING
      ) {
        app.debug(
          `No GPS position received for ${myVessel.lastSeenSecondsAgo} seconds`,
        ); // we use app.debug rather than app.error so that the user can filter these out of the log
        // the message stays fixed, so it is raised once rather than re-raised
        // every tick with a new seconds count
        const message = `No GPS position received for more than ${NO_GPS_FIX_WARNING} seconds`;
        app.setPluginError(message);
        if (enableAlarmPublishing) {
          setNotification(OWN_VESSEL, STATUS_ALARM, message);
        }
        return;
      }

      if (enableAlarmPublishing) {
        setNotification(OWN_VESSEL, STATUS_NORMAL, "GPS position received");
      }

      for (const vessel of Object.values(vessels)) {
        if (vessel.context === vesselsState.myVesselContext) continue;

        const ignore =
          vessel.range === undefined ||
          vessel.range / METERS_PER_NM > maximumTargetRange;

        if (enableDataPublishing) {
          if (ignore) {
            // forget it, so it is published afresh if it comes back into range
            lastPublished.delete(vessel.context);
          } else {
            publishTargetData(vessel);
          }
        }

        // publish warning/alarm notifications
        if (enableAlarmPublishing) {
          if (vessel.alarmState && !vessel.alarmIsMuted && !ignore) {
            const message = (
              `${vessel.name || `<${vessel.mmsi}>`} - ` +
              `${vessel.alarmType} ` +
              `${vessel.alarmState === "danger" ? "alarm" : vessel.alarmState}`
            ).toUpperCase();

            setNotification(
              vessel.context,
              vessel.alarmState === "warning" ? STATUS_WARN : STATUS_ALARM,
              message,
            );
          } else {
            setNotification(vessel.context, STATUS_NORMAL, "Watching");
          }
        }
      } // end loop

      // a vessel aged out of the vessel list would otherwise leave its last alarm
      // standing in signal k for good
      for (const context of notifications.keys()) {
        if (context !== OWN_VESSEL && !(context in vessels)) {
          setNotification(context, STATUS_NORMAL, "Watching");
          notifications.delete(context);
        }
      }
      for (const context of lastPublished.keys()) {
        if (!(context in vessels)) lastPublished.delete(context);
      }

      app.setPluginStatus(
        `Watching ${Object.keys(vessels).length - 1} targets`,
      );
    } catch (err) {
      app.debug("error in refreshDataModel", err);
    }
  }

  // publish a target's derived data, but only when it has moved on enough from what
  // signal k already holds - or when that has gone long enough without a refresh
  // that consumers would start treating it as stale. republishing every vessel on
  // every tick floods the server with deltas that change nothing.
  function publishTargetData(vessel: Vessel) {
    const data: PublishedTargetData = {
      cpa: vessel.cpa,
      tcpa: vessel.tcpa,
      range: vessel.range,
      bearing: vessel.bearing,
      alarmType: vessel.alarmType,
      alarmState: vessel.alarmState,
    };
    const now = Date.now();
    const previous = lastPublished.get(vessel.context);

    if (
      previous &&
      now - previous.at < PUBLISH_MAX_INTERVAL &&
      !hasTargetDataChanged(previous.data, data)
    ) {
      return;
    }

    pushTargetDataToSignalK(vessel);
    lastPublished.set(vessel.context, { at: now, data });
  }

  function pushTargetDataToSignalK(vessel: Vessel): void {
    app.handleMessage(plugin.id, {
      context: vessel.context as Context,
      updates: [
        {
          values: [
            {
              path: "navigation.closestApproach" as Path,
              value: {
                distance: vessel.cpa,
                timeTo: vessel.tcpa,
                range: vessel.range,
                bearing: vessel.bearing,
                collisionRiskRating: vessel.order,
                collisionAlarmType: vessel.alarmType,
                collisionAlarmState: vessel.alarmState,
              },
            },
          ],
        },
      ],
    });
  }

  // raise, update or clear a notification - but only send it when it differs from
  // what this plugin last sent for that vessel. re-sending an unchanged alarm every
  // tick makes some consumers sound it again each time.
  function setNotification(
    context: Context | typeof OWN_VESSEL,
    state: string,
    message: string,
  ) {
    const key = `${state}|${message}`;
    const previous = notifications.get(context);
    if (previous === key) return;

    // only clear what is actually raised: either we raised it, or a target's alarm
    // was left behind by an earlier run of the plugin. our own vessel's path is
    // only ever cleared after we raised it - something else may own an alarm there.
    if (
      state === STATUS_NORMAL &&
      previous === undefined &&
      (context === OWN_VESSEL || !hasAlarmNotification(context))
    ) {
      return;
    }

    sendNotification({
      state,
      message,
      ...(context === OWN_VESSEL ? {} : { context }),
      path: NOTIFICATION_PATH,
    });
    notifications.set(context, key);
  }

  function clearAllNotifications() {
    for (const [context, key] of notifications) {
      if (!key.startsWith(`${STATUS_NORMAL}|`)) {
        sendNotification({
          state: STATUS_NORMAL,
          message: "Not watching - plugin stopped",
          ...(context === OWN_VESSEL ? {} : { context }),
          path: NOTIFICATION_PATH,
        });
      }
    }
    notifications.clear();
  }

  function sendNotification({
    state,
    message,
    context,
    path,
  }: {
    state: string;
    message: string;
    context?: Context;
    path: Path;
  }): void {
    // app.debug("sendNotification", state, message);
    const delta = {
      ...(context ? { context: context } : {}),
      updates: [
        {
          values: [
            {
              path: path,
              value: {
                state: state,
                method:
                  state === STATUS_NORMAL ? ["visual"] : ["visual", "sound"],
                message: message,
              },
            },
          ],
        },
      ],
    };

    app.handleMessage(plugin.id, delta);
  }

  function hasAlarmNotification(context: Context) {
    const path = `${context}.${NOTIFICATION_PATH}.value.state`;
    const state = app.getPath(path);

    if (state && state !== STATUS_NORMAL) {
      return true;
    }

    return false;
  }

  // NOTE this may not be ready for prime time - and may not be needed given we update alarm notifications to "watchhing"
  // function silenceAllAlarmNotifications() {
  //   for (const context of Object.keys(vessels) as Context[]) {
  //     silenceAlarmNotification(context);
  //   }
  // }

  // NOTE this may not be ready for prime time - and may not be needed given we update alarm notifications to "watchhing"
  // function silenceAlarmNotification(context: Context) {
  //   const path =
  //     `${context}.notifications.navigation.closestApproach.value` as Path;
  //   const alarm = app.getPath(path) as Notification;

  //   if (!alarm) return;

  //   app.debug(`silensing sk alarm notification for ${context}`);

  //   // NOTE not using the API yet as it is not widely supported
  //   // http://raspberrypi.local:3000/admin/#/documentation/Developing/REST_APIs/Notifications_API.html#silencing-an-alarm
  //   // /signalk/v2/api/notifications/{notificationId}/silence

  //   // sound value is removed from the method attribute
  //   alarm.method = alarm.method.filter((m: string) => m !== "sound");

  //   // status.silenced is set to true
  //   if (alarm.status) alarm.status.silenced = true;

  //   app.handleMessage(plugin.id, {
  //     context: context,
  //     updates: [
  //       {
  //         values: [
  //           {
  //             path: path,
  //             value: alarm,
  //           },
  //         ],
  //       },
  //     ],
  //   });
  // }

  return plugin;
}
