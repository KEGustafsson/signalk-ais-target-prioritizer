import fs from "node:fs";
import path from "node:path";
import defaultCollisionProfiles from "../web/assets/defaultCollisionProfiles.json" with {
	type: "json",
};
import {
	processDelta as sharedProcessDelta,
	updateDerivedData,
} from "../web/assets/scripts/ais-utils.mjs";
import {
	TARGET_MAX_AGE,
	PUBLISH_THRESHOLDS,
} from "../shared/constants.mjs";
import schema from "./schema.json" with { type: "json" };
import * as vesper from "./vesper-xb8000-emulator.mjs";

const AGE_OUT_OLD_TARGETS = true;

/** Regular expression for validating MMSI format (9 digits) */
const MMSI_REGEX = /^[0-9]{9}$/;

let selfMmsi;
let selfName;
let selfCallsign;
let selfTypeId;
let selfTarget;

const targets = new Map();
let collisionProfiles;
let options;

export default function (app) {
	const plugin = {};
	let unsubscribes = [];

	let refreshDataModelInterval;

	plugin.id = "signalk-ais-target-prioritizer";
	plugin.name = "SignalK AIS Target Prioritizer";
	plugin.description =
		"A SignalK plugin that priorizes AIS targets according to guard and CPA criteria";

	plugin.start = (_options) => {
		app.debug(`*** Starting plugin ${plugin.id} with options=`, _options);
		options = _options;
		getCollisionProfiles();
		if (
			options.enableDataPublishing ||
			options.enableAlarmPublishing ||
			options.enableEmulator
		) {
			enablePluginCpaCalculations();
		} else {
			// if plugin was stopped and started again with options set to not perform calculations, then clear out old targets
			targets.clear();
		}
		if (options.enableEmulator) {
			//app.debug("collisionProfiles in index.js", collisionProfiles);
			//vesper.collisionProfiles = collisionProfiles;
			//vesper.setCollisionProfiles(collisionProfiles);
			vesper.start(
				app,
				collisionProfiles,
				selfMmsi,
				selfName,
				selfCallsign,
				selfTypeId,
				targets,
				saveCollisionProfiles,
			);
		}
	};

	plugin.stop = () => {
		app.debug(`Stopping plugin ${plugin.id}`);
		unsubscribes.forEach((f) => f());
		unsubscribes = [];
		if (refreshDataModelInterval) {
			clearInterval(refreshDataModelInterval);
		}
		if (options?.enableEmulator) {
			vesper.stop();
		}
	};

	plugin.schema = schema;

	plugin.registerWithRouter = (router) => {
		// GET /plugins/${plugin.id}/getCollisionProfiles
		router.get("/getCollisionProfiles", (_req, res) => {
			app.debug("getCollisionProfiles", collisionProfiles);
			res.json(collisionProfiles);
		});

		// PUT /plugins/${plugin.id}/setCollisionProfiles
		router.put("/setCollisionProfiles", (req, res) => {
			const newCollisionProfiles = req.body;
			app.debug("setCollisionProfiles", newCollisionProfiles);
			// do some basic validation to ensure we have some real config data before saving it
			if (
				!newCollisionProfiles ||
				!newCollisionProfiles.current ||
				!newCollisionProfiles.anchor ||
				!newCollisionProfiles.harbor ||
				!newCollisionProfiles.coastal ||
				!newCollisionProfiles.offshore
			) {
				app.error(
					"ERROR - not saving invalid new collision profiles",
					newCollisionProfiles,
				);
				res.status(500).end();
				return;
			}
			// must use Object.assign rather than "collisionProfiles = newCollisionProfiles" to prevent breaking the reference we passed into the vesper emulator
			Object.assign(collisionProfiles, newCollisionProfiles);
			saveCollisionProfiles();
			res.json(collisionProfiles);
		});

		// POST /plugins/${plugin.id}/muteAllAlarms
		router.post("/muteAllAlarms", (_req, res) => {
			app.debug("muteAllAlarms");
			targets.forEach((target, mmsi) => {
				if (target.alarmState === "danger" && !target.alarmIsMuted) {
					app.debug(
						"muting alarm for target",
						mmsi,
						target.name,
						target.alarmType,
						target.alarmState,
					);
					target.alarmIsMuted = true;
				}
			});
			res.json();
		});

		// PUT /plugins/${plugin.id}/setAlarmIsMuted
		router.put("/setAlarmIsMuted", (req, res) => {
			const { mmsi, alarmIsMuted } = req.body;
			if (!mmsi || alarmIsMuted === undefined) {
				res.status(400).json({ error: "mmsi and alarmIsMuted required" });
				return;
			}
			// Validate MMSI format
			if (typeof mmsi !== "string" || !MMSI_REGEX.test(mmsi)) {
				res.status(400).json({ error: "Invalid MMSI format (must be 9 digits)" });
				return;
			}
			app.debug("setting alarmIsMuted", mmsi, alarmIsMuted);
			if (targets.has(mmsi)) {
				targets.get(mmsi).alarmIsMuted = !!alarmIsMuted;
				res.json({ success: true });
			} else {
				res.status(404).json({ error: "Target not found" });
			}
		});

		// GET /plugins/${plugin.id}/getTargets
		router.get("/getTargets", (_req, res) => {
			app.debug("getTargets", targets.size);
			res.json(Object.fromEntries(targets));
		});

		// GET /plugins/${plugin.id}/getTarget/:mmsi
		router.get("/getTarget/:mmsi", (req, res) => {
			const mmsi = req.params.mmsi;
			app.debug("getTarget", mmsi);
			if (targets.has(mmsi)) {
				res.json(targets.get(mmsi));
			} else {
				res.status(404).end();
			}
		});
	};

	function getCollisionProfiles() {
		try {
			const dataDirPath = app.getDataDirPath();
			const collisionProfilesPath = path.join(
				dataDirPath,
				"collisionProfiles.json",
			);
			if (fs.existsSync(collisionProfilesPath)) {
				app.debug("Reading file", collisionProfilesPath);
				collisionProfiles = JSON.parse(
					fs.readFileSync(collisionProfilesPath).toString(),
				);
			} else {
				app.debug(
					"collisionProfiles.json not found, using defaultCollisionProfiles",
					collisionProfilesPath,
				);
				collisionProfiles = defaultCollisionProfiles;
				saveCollisionProfiles();
			}
		} catch (err) {
			app.error("Error reading collisionProfiles.json:", err);
			throw err;
		}
	}

	function saveCollisionProfiles() {
		app.debug("saving ", collisionProfiles);

		const dataDirPath = app.getDataDirPath();

		if (!fs.existsSync(dataDirPath)) {
			try {
				fs.mkdirSync(dataDirPath, { recursive: true });
			} catch (err) {
				app.error("Error creating dataDirPath:", err);
				throw err;
			}
		}

		const collisionProfilesPath = path.join(
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
			app.error("Error writing collisionProfiles.json:", err);
			throw err;
		}
	}

	function enablePluginCpaCalculations() {
		selfMmsi = app.getSelfPath("mmsi");
		selfName = app.getSelfPath("name");
		selfCallsign = app.getSelfPath("communication")
			? app.getSelfPath("communication").callsignVhf
			: "";
		selfTypeId = app.getSelfPath("design.aisShipType")
			? app.getSelfPath("design.aisShipType").value.id
			: "";

		// *
		// atons.*
		// vessels.*
		// vessels.self
		const localSubscription = {
			context: "*", // we need both vessels and atons
			subscribe: [
				{
					// "name" is in the root path
					// and "communication.callsignVhf"
					// and imo
					path: "",
					period: 1000,
				},
				{
					path: "navigation.position",
					period: 1000,
				},
				{
					path: "navigation.courseOverGroundTrue",
					period: 1000,
				},
				{
					path: "navigation.speedOverGround",
					period: 1000,
				},
				{
					path: "navigation.magneticVariation",
					period: 1000,
				},
				{
					path: "navigation.headingTrue",
					period: 1000,
				},
				{
					path: "navigation.state",
					period: 1000,
				},
				{
					path: "navigation.destination.commonName",
					period: 1000,
				},
				{
					path: "navigation.rateOfTurn",
					period: 1000,
				},
				{
					path: "design.*",
					period: 1000,
				},
				{
					path: "sensors.ais.class",
					period: 1000,
				},
				{
					path: "atonType",
					period: 1000,
				},
				{
					path: "offPosition",
					period: 1000,
				},
				{
					path: "virtual",
					period: 1000,
				},
			],
		};

		app.subscriptionmanager.subscribe(
			localSubscription,
			unsubscribes,
			(subscriptionError) => {
				app.error(`Error:${subscriptionError}`);
			},
			(delta) => {
				const mmsi = sharedProcessDelta(delta, targets);
				if (!mmsi) {
					app.debug(
						"ERROR: received a delta with an invalid mmsi",
						JSON.stringify(delta, null, "\t"),
					);
				}
			},
		);

		// update data model every 1 second
		refreshDataModelInterval = setInterval(refreshDataModel, 1000);
	}

	async function refreshDataModel() {
		try {
			// collisionProfiles.setFromIndex = Math.floor(new Date().getTime() / 1000);
			// app.debug('index.js: setFromIndex,setFromEmulator', collisionProfiles.setFromIndex, collisionProfiles.setFromEmulator, collisionProfiles.anchor.guard.range);
			// app.debug("collisionProfiles.anchor.guard.range - index ",collisionProfiles.anchor.guard.range);

			selfTarget = targets.get(selfMmsi);

			// Wait for valid self vessel data before processing
			if (
				!selfTarget ||
				selfTarget.latitude == null ||
				selfTarget.longitude == null
			) {
				app.setPluginStatus("Waiting for own vessel GPS position...");
				return;
			}

			try {
				updateDerivedData(
					targets,
					selfTarget,
					collisionProfiles,
					TARGET_MAX_AGE,
				);
			} catch (error) {
				app.debug(error); // we use app.debug rather than app.error so that the user can filter these out of the log
				app.setPluginError(error.message);
				sendNotification("alarm", error.message);
				return;
			}

			if (selfTarget.lastSeen > 30) {
				const message = `No GPS position received for more than ${selfTarget.lastSeen} seconds`;
				app.debug(message); // we use app.debug rather than app.error so that the user can filter these out of the log
				app.setPluginError(message);
				sendNotification("alarm", message);
				return;
			}

			let isCurrentAlarm = false;

			targets.forEach((target, mmsi) => {
				if (options.enableDataPublishing && mmsi !== selfMmsi) {
					// Only publish if target data has changed significantly
					if (hasTargetDataChanged(target)) {
						pushTargetDataToSignalK(target);
						// Store last published values
						target.lastPublishedCpa = target.cpa;
						target.lastPublishedTcpa = target.tcpa;
						target.lastPublishedRange = target.range;
						target.lastPublishedBearing = target.bearing;
						target.lastPublishedAlarmState = target.alarmState;
					}
				}

				// publish warning/alarm notifications only when alarm state changes
				if (
					options.enableAlarmPublishing &&
					target.alarmState &&
					!target.alarmIsMuted
				) {
					// Only send notification if alarm state or type has changed
					const alarmStateChanged =
						target.alarmState !== target.lastNotifiedAlarmState ||
						target.alarmType !== target.lastNotifiedAlarmType;

					if (alarmStateChanged) {
						const message = (
							`${target.name || `<${target.mmsi}>`} - ` +
							`${target.alarmType} ` +
							`${target.alarmState === "danger" ? "alarm" : target.alarmState}`
						).toUpperCase();
						if (target.alarmState === "warning") {
							sendNotification("warn", message);
						} else if (target.alarmState === "danger") {
							sendNotification("alarm", message);
						}
						// Track what we notified about
						target.lastNotifiedAlarmState = target.alarmState;
						target.lastNotifiedAlarmType = target.alarmType;
					}
					isCurrentAlarm = true;
				} else if (target.lastNotifiedAlarmState) {
					// Alarm was cleared or muted - reset tracking
					target.lastNotifiedAlarmState = null;
					target.lastNotifiedAlarmType = null;
				}

				if (AGE_OUT_OLD_TARGETS && target.lastSeen > TARGET_MAX_AGE) {
					app.debug(
						"ageing out target",
						target.mmsi,
						target.name,
						target.lastSeen,
					);
					targets.delete(target.mmsi);
				}
			});

			// if there are no active alarms, yet still an alarm notification, then clean the alarm notification
			if (!isCurrentAlarm && isCurrentAlarmNotification()) {
				sendNotification("normal", "watching");
			}

			app.setPluginStatus(`Watching ${targets.size - 1} targets`);
		} catch (err) {
			app.debug("error in refreshDataModel", err.message, err);
		}
	}

	/**
	 * Check if target data has changed enough to warrant publishing.
	 * Uses thresholds to avoid flooding SignalK with minor changes.
	 * @param {Object} target - The target to check
	 * @returns {boolean} - True if data should be published
	 */
	function hasTargetDataChanged(target) {
		// Always publish if never published before
		if (target.lastPublishedCpa === undefined) {
			return true;
		}

		// Publish if alarm state changed
		if (target.alarmState !== target.lastPublishedAlarmState) {
			return true;
		}

		// Publish if CPA changed by more than threshold
		if (
			target.cpa != null &&
			target.lastPublishedCpa != null &&
			Math.abs(target.cpa - target.lastPublishedCpa) > PUBLISH_THRESHOLDS.CPA_METERS
		) {
			return true;
		}

		// Publish if TCPA changed by more than threshold
		if (
			target.tcpa != null &&
			target.lastPublishedTcpa != null &&
			Math.abs(target.tcpa - target.lastPublishedTcpa) > PUBLISH_THRESHOLDS.TCPA_SECONDS
		) {
			return true;
		}

		// Publish if range changed by more than threshold
		if (
			target.range != null &&
			target.lastPublishedRange != null &&
			Math.abs(target.range - target.lastPublishedRange) > PUBLISH_THRESHOLDS.RANGE_METERS
		) {
			return true;
		}

		// Publish if bearing changed by more than threshold
		if (
			target.bearing != null &&
			target.lastPublishedBearing != null &&
			Math.abs(target.bearing - target.lastPublishedBearing) > PUBLISH_THRESHOLDS.BEARING_DEGREES
		) {
			return true;
		}

		// Publish if values went from null to non-null or vice versa
		if (
			(target.cpa == null) !== (target.lastPublishedCpa == null) ||
			(target.tcpa == null) !== (target.lastPublishedTcpa == null)
		) {
			return true;
		}

		return false;
	}

	function pushTargetDataToSignalK(target) {
		app.handleMessage(plugin.id, {
			context: target.context,
			updates: [
				{
					values: [
						{
							path: "navigation.closestApproach",
							value: {
								distance: target.cpa,
								timeTo: target.tcpa,
								range: target.range,
								bearing: target.bearing,
								collisionRiskRating: target.order,
								collisionAlarmType: target.alarmType,
								collisionAlarmState: target.alarmState,
							},
						},
					],
				},
			],
		});
	}

	function sendNotification(state, message) {
		app.debug("sendNotification", state, message);
		const delta = {
			updates: [
				{
					values: [
						{
							path: "notifications.navigation.closestApproach",
							value: {
								state: state,
								method: ["visual", "sound"],
								message: message,
							},
						},
					],
				},
			],
		};

		app.handleMessage(plugin.id, delta);
	}

	function isCurrentAlarmNotification() {
		const notifications = app.getSelfPath(
			"notifications.navigation.closestApproach",
		);
		return notifications?.value?.state === "alarm";
	}

	return plugin;
}
