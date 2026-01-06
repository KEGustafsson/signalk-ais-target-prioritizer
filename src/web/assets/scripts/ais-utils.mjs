import { mmsiMidToCountry } from "./mmsi-mid-decoder.mjs";
import {
	METERS_PER_NM,
	KNOTS_PER_M_PER_S,
	LOST_TARGET_WARNING_AGE,
	TCPA_MAX_SECONDS,
	PRIORITY_ORDER,
	PRIORITY_WEIGHTS,
} from "../../../shared/constants.mjs";

/**
 * Process a SignalK delta message and update the target in the targets map.
 * Shared between frontend (WebSocket) and backend (subscription).
 * @param {Object} delta - The SignalK delta message
 * @param {Map} targets - Map of targets keyed by MMSI
 * @returns {string|null} - The MMSI of the updated target, or null if invalid
 */
export function processDelta(delta, targets) {
	if (!delta.context) return null;

	const mmsi = delta.context.slice(-9);
	if (!mmsi || !/^[0-9]{9}$/.test(mmsi)) return null;

	let target = targets.get(mmsi);
	if (!target) {
		target = { sog: 0, cog: 0, mmsi: mmsi, needsRecalc: true };
	}
	target.context = delta.context;

	const updates = delta.updates;
	if (!updates) return mmsi;

	for (const update of updates) {
		const values = update.values;
		if (!values) continue;

		for (const value of values) {
			switch (value.path) {
				case "":
					if (value.value.name) {
						target.name = value.value.name;
					} else if (value.value.communication?.callsignVhf) {
						target.callsign = value.value.communication.callsignVhf;
					} else if (value.value.registrations?.imo) {
						target.imo = value.value.registrations.imo.replace(/imo/i, "");
					}
					break;
				case "navigation.position":
					target.latitude = value.value.latitude;
					target.longitude = value.value.longitude;
					target.lastSeenDate = new Date(update.timestamp);
					target.needsRecalc = true; // Position changed - recalculate
					break;
				case "navigation.courseOverGroundTrue":
					target.cog = value.value;
					target.needsRecalc = true; // Course changed - recalculate
					break;
				case "navigation.speedOverGround":
					target.sog = value.value;
					target.needsRecalc = true; // Speed changed - recalculate
					break;
				case "navigation.magneticVariation":
					target.magvar = value.value;
					break;
				case "navigation.headingTrue":
					target.hdg = value.value;
					break;
				case "navigation.rateOfTurn":
					target.rot = value.value;
					break;
				case "design.aisShipType":
					target.typeId = value.value.id;
					target.type = value.value.name;
					break;
				case "navigation.state":
					target.status = value.value;
					break;
				case "sensors.ais.class":
					target.aisClass = value.value;
					break;
				case "navigation.destination.commonName":
					target.destination = value.value;
					break;
				case "design.length":
					target.length = value.value.overall;
					break;
				case "design.beam":
					target.beam = value.value;
					break;
				case "design.draft":
					target.draft = value.value.current;
					break;
				case "atonType":
					target.typeId = value.value.id;
					target.type = value.value.name;
					if (target.status == null) {
						target.status = "default";
					}
					break;
				case "offPosition":
					target.isOffPosition = value.value ? 1 : 0;
					break;
				case "virtual":
					target.isVirtual = value.value ? 1 : 0;
					break;
			}
		}
	}

	targets.set(mmsi, target);
	return mmsi;
}

/**
 * Updates derived data for all targets (range, bearing, CPA, TCPA, alarms).
 * This is the main calculation loop that should be called periodically (e.g., every second).
 *
 * @param {Map<string, Object>} targets - Map of all AIS targets keyed by MMSI
 * @param {Object} selfTarget - The own vessel target (must have valid lat/lon)
 * @param {Object} collisionProfiles - Collision profile configuration with thresholds
 * @param {number} TARGET_MAX_AGE - Maximum age in seconds before a target is considered stale
 * @throws {Error} If selfTarget is missing or has invalid position data
 */
export function updateDerivedData(
	targets,
	selfTarget,
	collisionProfiles,
	TARGET_MAX_AGE,
) {
	// update self first
	if (!selfTarget) {
		console.warn(
			"No GPS position available (no data for our own vessel)",
			selfTarget,
		);
		// Caller is responsible for handling this error and showing appropriate UI/notification
		throw new Error("No GPS position available (no data for our own vessel)");
	}

	updateSingleTargetDerivedData(
		selfTarget,
		selfTarget,
		collisionProfiles,
		TARGET_MAX_AGE,
	);

	if (!selfTarget.isValid) {
		console.warn("No GPS position available (data is invalid)", selfTarget);
		// Caller is responsible for handling this error and showing appropriate UI/notification
		throw new Error("No GPS position available (data is invalid)");
	}

	// then update all other targets
	targets.forEach((target, mmsi) => {
		if (mmsi !== selfTarget.mmsi) {
			updateSingleTargetDerivedData(
				target,
				selfTarget,
				collisionProfiles,
				TARGET_MAX_AGE,
			);
		}
	});
}

export function toRadians(v) {
	return (v * Math.PI) / 180;
}

export function toDegrees(v) {
	return (v * 180) / Math.PI;
}

/**
 * Updates derived data for a single target (range, bearing, CPA, TCPA, alarms).
 * Exported for event-based updates when a single target's data changes.
 */
export function updateSingleTargetDerivedData(
	target,
	selfTarget,
	collisionProfiles,
	TARGET_MAX_AGE,
) {
	// Guard against null/undefined/NaN values
	const lat = target.latitude ?? 0;
	const lon = target.longitude ?? 0;
	const sog = target.sog ?? 0;
	const cog = target.cog ?? 0;
	const selfLat = selfTarget.latitude ?? 0;

	// Clamp latitude to avoid polar singularity (cos(90°) = 0)
	const clampedSelfLat = Math.max(-89.9, Math.min(89.9, selfLat));

	target.y = lat * 111120;
	// Using self vessel latitude for longitude scaling is sufficient for short ranges
	// An average of latitudes would improve accuracy for targets far N/S, but adds complexity
	target.x = lon * 111120 * Math.cos(toRadians(clampedSelfLat));
	target.vy = sog * Math.cos(cog); // cog is in radians
	target.vx = sog * Math.sin(cog); // cog is in radians

	if (target.mmsi !== selfTarget.mmsi) {
		calculateRangeAndBearing(selfTarget, target);
		updateCpa(selfTarget, target);
		evaluateAlarms(target, collisionProfiles);
	}

	let lastSeen = Math.round((Date.now() - target.lastSeenDate) / 1000);
	if (lastSeen < 0) {
		lastSeen = 0;
	}

	const mmsiMid = getMid(target.mmsi);

	target.lastSeen = lastSeen;
	target.isLost = lastSeen > LOST_TARGET_WARNING_AGE;
	target.mmsiCountryCode = mmsiMidToCountry.get(mmsiMid)?.code;
	target.mmsiCountryName = mmsiMidToCountry.get(mmsiMid)?.name;
	target.cpaFormatted = formatCpa(target.cpa);
	target.tcpaFormatted = formatTcpa(target.tcpa);
	target.rangeFormatted =
		target.range != null
			? `${(target.range / METERS_PER_NM).toFixed(2)} NM`
			: "---";
	target.bearingFormatted =
		target.bearing != null ? `${target.bearing} T` : "---";
	target.sogFormatted =
		target.sog != null
			? `${(target.sog * KNOTS_PER_M_PER_S).toFixed(1)} kn`
			: "---";
	target.cogFormatted =
		target.cog != null ? `${Math.round(toDegrees(target.cog))} T` : "---";
	target.hdgFormatted =
		target.hdg != null ? `${Math.round(toDegrees(target.hdg))} T` : "---";
	target.rotFormatted = Math.round(toDegrees(target.rot)) || "---";
	target.aisClassFormatted =
		target.aisClass + (target.isVirtual ? " (virtual)" : "");
	target.sizeFormatted = `${target.length?.toFixed(1) ?? "---"} m x ${target.beam?.toFixed(1) ?? "---"} m`;
	target.imoFormatted = target.imo?.replace(/imo/i, "") || "---";
	target.latitudeFormatted = formatLat(target.latitude);
	target.longitudeFormatted = formatLon(target.longitude);

	// Use proper null checks - !value fails for lat=0 (equator) or lon=0 (prime meridian)
	if (
		target.latitude == null ||
		target.longitude == null ||
		target.lastSeen > TARGET_MAX_AGE
	) {
		//console.log("invalid target", target.mmsi, target.latitude, target.longitude, target.lastSeen);
		target.isValid = false;
	} else {
		target.isValid = true;
	}
}

function calculateRangeAndBearing(selfTarget, target) {
	// Check actual data directly instead of relying on isValid flag which may not be set yet
	// Use proper null checks - !value fails for lat=0 (equator) or lon=0 (prime meridian)
	if (
		selfTarget.latitude == null ||
		selfTarget.longitude == null ||
		target.latitude == null ||
		target.longitude == null
	) {
		target.range = null;
		target.bearing = null;
		// console.log('cant calc range bearing', selfTarget, target);
		return;
	}

	target.range = Math.round(
		getDistanceFromLatLonInMeters(
			selfTarget.latitude,
			selfTarget.longitude,
			target.latitude,
			target.longitude,
		),
	);
	target.bearing = Math.round(
		getRhumbLineBearing(
			selfTarget.latitude,
			selfTarget.longitude,
			target.latitude,
			target.longitude,
		),
	);

	if (target.bearing >= 360) {
		target.bearing = 0;
	}
}

// from: http://geomalgorithms.com/a07-_distance.html
function updateCpa(selfTarget, target) {
	if (
		selfTarget.x == null ||
		selfTarget.y == null ||
		selfTarget.vx == null ||
		selfTarget.vy == null ||
		target.x == null ||
		target.y == null ||
		target.vx == null ||
		target.vy == null
	) {
		//console.log('cant calc cpa: missing data', target.mmsi);
		target.cpa = null;
		target.tcpa = null;
		return;
	}

	// dv = Tr1.v - Tr2.v
	// this is relative speed
	// m/s
	const dv = {
		x: target.vx - selfTarget.vx,
		y: target.vy - selfTarget.vy,
	};

	// (m/s)^2
	const dv2 = dot(dv, dv);

	// guard against division by zero
	// the tracks are almost parallel
	// or there is almost no relative movement
	if (dv2 < 0.00000001) {
		// console.log('cant calc tcpa: ',target.mmsi);
		target.cpa = null;
		target.tcpa = null;
		return;
	}

	// w0 = Tr1.P0 - Tr2.P0
	// this is relative position
	// 111120 m / deg lat
	// m
	const w0 = {
		x: target.x - selfTarget.x,
		y: target.y - selfTarget.y,
	};

	// in secs
	// m * m/s / (m/s)^2 = m / (m/s) = s
	const tcpa = -dot(w0, dv) / dv2;

	// if tcpa is in the past,
	// or if tcpa is more than TCPA_MAX_SECONDS in the future
	// then dont calc cpa & tcpa
	if (!tcpa || tcpa < 0 || tcpa > TCPA_MAX_SECONDS) {
		//console.log('discarding tcpa: ', target.mmsi, tcpa);
		target.cpa = null;
		target.tcpa = null;
		return;
	}

	// Point P1 = Tr1.P0 + (ctime * Tr1.v);
	// m
	const p1 = {
		x: selfTarget.x + tcpa * selfTarget.vx,
		y: selfTarget.y + tcpa * selfTarget.vy,
	};

	// Point P2 = Tr2.P0 + (ctime * Tr2.v);
	// m
	const p2 = {
		x: target.x + tcpa * target.vx,
		y: target.y + tcpa * target.vy,
	};

	// in meters
	const cpa = dist(p1, p2);

	// Guard against NaN results
	if (!Number.isFinite(cpa) || !Number.isFinite(tcpa)) {
		target.cpa = null;
		target.tcpa = null;
		return;
	}

	// in meters
	target.cpa = Math.round(cpa);
	// in seconds
	target.tcpa = Math.round(tcpa);
}

// #define dot(u,v) ((u).x * (v).x + (u).y * (v).y + (u).z * (v).z)
function dot(u, v) {
	return u.x * v.x + u.y * v.y;
}

// #define norm(v) sqrt(dot(v,v))
// norm = length of vector
function norm(v) {
	return Math.sqrt(dot(v, v));
}

// #define d(u,v) norm(u-v)
// distance = norm of difference
function dist(u, v) {
	return norm({
		x: u.x - v.x,
		y: u.y - v.y,
	});
}

function evaluateAlarms(target, collisionProfiles) {
	try {
		// guard alarm
		target.guardAlarm =
			target.range != null &&
			target.range <
				collisionProfiles[collisionProfiles.current].guard.range *
					METERS_PER_NM &&
			(collisionProfiles[collisionProfiles.current].guard.speed === 0 ||
				(target.sog != null &&
					target.sog >
						collisionProfiles[collisionProfiles.current].guard.speed /
							KNOTS_PER_M_PER_S));

		// collision alarm
		target.collisionAlarm =
			target.cpa != null &&
			target.cpa <
				collisionProfiles[collisionProfiles.current].danger.cpa *
					METERS_PER_NM &&
			target.tcpa != null &&
			target.tcpa > 0 &&
			target.tcpa < collisionProfiles[collisionProfiles.current].danger.tcpa &&
			(collisionProfiles[collisionProfiles.current].danger.speed === 0 ||
				(target.sog != null &&
					target.sog >
						collisionProfiles[collisionProfiles.current].danger.speed /
							KNOTS_PER_M_PER_S));

		// collision warning
		target.collisionWarning =
			target.cpa != null &&
			target.cpa <
				collisionProfiles[collisionProfiles.current].warning.cpa *
					METERS_PER_NM &&
			target.tcpa != null &&
			target.tcpa > 0 &&
			target.tcpa < collisionProfiles[collisionProfiles.current].warning.tcpa &&
			(collisionProfiles[collisionProfiles.current].warning.speed === 0 ||
				(target.sog != null &&
					target.sog >
						collisionProfiles[collisionProfiles.current].warning.speed /
							KNOTS_PER_M_PER_S));

		target.sartAlarm = target.mmsi.startsWith("970");
		target.mobAlarm = target.mmsi.startsWith("972");
		target.epirbAlarm = target.mmsi.startsWith("974");

		// Order/priority logic:
		// - Base order: alarm (10000) < warning (20000) < closing (30000) < diverging (40000)
		// - Modifiers: shorter TCPA and smaller CPA reduce order (higher priority)
		// - Greater range increases order (lower priority)

		// alarm
		if (
			target.guardAlarm ||
			target.collisionAlarm ||
			target.sartAlarm ||
			target.mobAlarm ||
			target.epirbAlarm
		) {
			target.alarmState = "danger";
			target.order = PRIORITY_ORDER.DANGER;
		}
		// warning
		else if (target.collisionWarning) {
			target.alarmState = "warning";
			target.order = PRIORITY_ORDER.WARNING;
		}
		// no alarm/warning - but has positive tcpa (closing)
		else if (target.tcpa != null && target.tcpa > 0) {
			target.alarmState = null;
			target.order = PRIORITY_ORDER.CLOSING;
		}
		// no alarm/warning and moving away
		else {
			target.alarmState = null;
			target.order = PRIORITY_ORDER.DIVERGING;
		}

		const alarms = [];

		if (target.guardAlarm) alarms.push("guard");
		if (target.collisionAlarm || target.collisionWarning) alarms.push("cpa");
		if (target.sartAlarm) alarms.push("sart");
		if (target.mobAlarm) alarms.push("mob");
		if (target.epirbAlarm) alarms.push("epirb");

		if (alarms.length > 0) {
			target.alarmType = alarms.join(",");
		} else {
			target.alarmType = null;
		}

		// sort sooner tcpa targets to top
		if (target.tcpa != null && target.tcpa > 0) {
			// sort vessels with any tcpa above vessels that dont have a tcpa
			target.order -= PRIORITY_WEIGHTS.HAS_TCPA_BONUS;
			// tcpa of 0 seconds reduces order by TCPA_WEIGHT
			// tcpa of 60 minutes reduces order by 0
			target.order -= Math.max(
				0,
				Math.round(
					PRIORITY_WEIGHTS.TCPA_WEIGHT -
						(PRIORITY_WEIGHTS.TCPA_WEIGHT * target.tcpa) / 3600,
				),
			);
		}

		// sort closer cpa targets to top
		if (target.cpa != null && target.cpa > 0) {
			// cpa of 0 nm reduces order by CPA_WEIGHT
			// cpa of 5 nm reduces order by 0
			target.order -= Math.max(
				0,
				Math.round(
					PRIORITY_WEIGHTS.CPA_WEIGHT -
						(PRIORITY_WEIGHTS.CPA_WEIGHT * target.cpa) / 5 / METERS_PER_NM,
				),
			);
		}

		// sort closer targets to top
		if (target.range != null && target.range > 0) {
			// range of 0 nm increases order by 0
			// larger range increases order, capped at RANGE_WEIGHT_MAX
			const rangeAdjust = Math.min(
				PRIORITY_WEIGHTS.RANGE_WEIGHT_MAX,
				Math.round(
					(PRIORITY_WEIGHTS.RANGE_WEIGHT_PER_NM * target.range) / METERS_PER_NM,
				),
			);
			target.order += rangeAdjust;
		}

		// sort targets with no range to bottom
		if (target.range == null) {
			target.order += PRIORITY_ORDER.NO_RANGE;
		}

		// Clamp final order to prevent any overflow issues
		target.order = Math.max(
			PRIORITY_WEIGHTS.ORDER_MIN,
			Math.min(PRIORITY_WEIGHTS.ORDER_MAX, target.order),
		);
	} catch (err) {
		console.error("error in evaluateAlarms", err.message, err);
	}
}

function getDistanceFromLatLonInMeters(lat1, lon1, lat2, lon2) {
	const R = 6371000; // Radius of the earth in meters
	const dLat = toRadians(lat2 - lat1);
	const dLon = toRadians(lon2 - lon1);
	const a =
		Math.sin(dLat / 2) * Math.sin(dLat / 2) +
		Math.cos(toRadians(lat1)) *
			Math.cos(toRadians(lat2)) *
			Math.sin(dLon / 2) *
			Math.sin(dLon / 2);
	const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
	const d = R * c; // Distance in meters
	return d;
}

function getRhumbLineBearing(lat1, lon1, lat2, lon2) {
	// difference of longitude coords
	let diffLon = toRadians(lon2 - lon1);

	// difference latitude coords phi
	const diffPhi = Math.log(
		Math.tan(toRadians(lat2) / 2 + Math.PI / 4) /
			Math.tan(toRadians(lat1) / 2 + Math.PI / 4),
	);

	// recalculate diffLon if it is greater than pi
	if (Math.abs(diffLon) > Math.PI) {
		if (diffLon > 0) {
			diffLon = (Math.PI * 2 - diffLon) * -1;
		} else {
			diffLon = Math.PI * 2 + diffLon;
		}
	}

	//return the angle, normalized
	return (toDegrees(Math.atan2(diffLon, diffPhi)) + 360) % 360;
}

// 012345678
// 8MIDXXXXX   Diver’s radio (not used in the U.S. in 2013)
// MIDXXXXXX   Ship
// 0MIDXXXXX   Group of ships; the U.S. Coast Guard, for example, is 03699999
// 00MIDXXXX   Coastal stations
// 111MIDXXX   SAR (Search and Rescue) aircraft
// 99MIDXXXX   Aids to Navigation
// 98MIDXXXX   Auxiliary craft associated with a parent ship
// 970MIDXXX   AIS SART (Search and Rescue Transmitter) (might be bad info - might be no MID)
// 972XXXXXX   MOB (Man Overboard) device (no MID)
// 974XXXXXX   EPIRB (Emergency Position Indicating Radio Beacon) AIS (no MID)
function getMid(mmsi) {
	if (mmsi.startsWith("111") || mmsi.startsWith("970")) {
		return mmsi.substring(3, 6);
	} else if (
		mmsi.startsWith("00") ||
		mmsi.startsWith("98") ||
		mmsi.startsWith("99")
	) {
		return mmsi.substring(2, 5);
	} else if (mmsi.startsWith("0") || mmsi.startsWith("8")) {
		return mmsi.substring(1, 4);
	} else {
		return mmsi.substring(0, 3);
	}
}

// N 39° 57.0689
function formatLat(dec) {
	const decAbs = Math.abs(dec);
	const deg = `0${Math.floor(decAbs)}`.slice(-2);
	const min = `0${((decAbs - deg) * 60).toFixed(4)}`.slice(-7);
	return `${dec > 0 ? "N" : "S"} ${deg}° ${min}`;
}

// W 075° 08.3692
function formatLon(dec) {
	const decAbs = Math.abs(dec);
	const deg = `00${Math.floor(decAbs)}`.slice(-3);
	const min = `0${((decAbs - deg) * 60).toFixed(4)}`.slice(-7);
	return `${dec > 0 ? "E" : "W"} ${deg}° ${min}`;
}

// 1.53 NM
function formatCpa(cpa) {
	// if cpa is null it should be returned as blank. toFixed makes it '0.00'
	return cpa != null ? `${(cpa / METERS_PER_NM).toFixed(2)} NM` : "---";
}

// hh:mm:ss or mm:ss e.g. 01:15:23 or 51:37
function formatTcpa(tcpa) {
	if (tcpa == null || tcpa < 0) {
		return "---";
	}
	// when more than 60 mins, then format hh:mm:ss
	else if (Math.abs(tcpa) >= 3600) {
		return new Date(1000 * Math.abs(tcpa)).toISOString().substring(11, 19); // + ' hours'
	}
	// when less than 60 mins, then format mm:ss
	else {
		return new Date(1000 * Math.abs(tcpa)).toISOString().substring(14, 19); // + ' mins'
	}
}
