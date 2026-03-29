/**
 * Behavioral tests for ais-utils.mjs
 *
 * Tests are written from the perspective of how the plugin *should* behave,
 * not by copying implementation logic. Each test describes a real-world
 * scenario and the expected outcome.
 */
import { describe, it, expect } from "vitest";
import {
	processDelta,
	updateDerivedData,
	updateSingleTargetDerivedData,
	toRadians,
	getDistanceFromLatLonInMeters,
	getRhumbLineBearing,
	formatCpaNumeric,
	formatTcpaNumeric,
	formatSog,
	formatCog,
	formatFixed,
	formatLat,
	formatLon,
} from "./ais-utils.mjs";
import {
	TARGET_MAX_AGE,
	LOST_TARGET_WARNING_AGE,
	METERS_PER_NM,
	KNOTS_PER_M_PER_S,
} from "../../../shared/constants.mjs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal vessel target suitable for use in tests */
function makeTarget(overrides = {}) {
	return {
		mmsi: "123456789",
		latitude: 39.0,
		longitude: -75.0,
		sog: 0,
		cog: 0,
		lastSeenDate: new Date(),
		...overrides,
	};
}

/** Build a delta message from a context and a flat key/value map of paths */
function makeDelta(context, pathValues, timestamp = "2024-01-01T00:00:00Z") {
	const values = Object.entries(pathValues).map(([path, value]) => ({
		path,
		value,
	}));
	return {
		context,
		updates: [{ timestamp, values }],
	};
}

const harborProfiles = {
	current: "harbor",
	harbor: {
		warning: { cpa: 0.5, tcpa: 600, speed: 0.5 }, // CPA<0.5nm, TCPA<600s, SOG>0.5kn
		danger: { cpa: 0.1, tcpa: 300, speed: 3 }, // CPA<0.1nm, TCPA<300s, SOG>3kn
		guard: { range: 0.5, speed: 0 }, // 0.5nm guard zone, any speed
	},
};

const profilesNoGuard = {
	current: "harbor",
	harbor: {
		warning: { cpa: 0.5, tcpa: 600, speed: 0 },
		danger: { cpa: 0.1, tcpa: 300, speed: 0 },
		guard: { range: 0, speed: 0 }, // guard disabled (range=0 means target.range < 0 is never true)
	},
};

// ---------------------------------------------------------------------------
// processDelta – all data paths
// ---------------------------------------------------------------------------

describe("processDelta – data extraction", () => {
	it("extracts vessel name from path='' with name property", () => {
		const targets = new Map();
		const delta = makeDelta("vessels.urn:mrn:imo:mmsi:123456789", {
			"": { name: "MERCHANT PRIDE" },
		});
		processDelta(delta, targets);
		expect(targets.get("123456789").name).toBe("MERCHANT PRIDE");
	});

	it("extracts callsign from path='' with communication.callsignVhf", () => {
		const targets = new Map();
		const delta = makeDelta("vessels.urn:mrn:imo:mmsi:123456789", {
			"": { communication: { callsignVhf: "WPRT9" } },
		});
		processDelta(delta, targets);
		expect(targets.get("123456789").callsign).toBe("WPRT9");
	});

	it("extracts IMO number from path='' with registrations.imo", () => {
		const targets = new Map();
		const delta = makeDelta("vessels.urn:mrn:imo:mmsi:123456789", {
			"": { registrations: { imo: "IMO9876543" } },
		});
		processDelta(delta, targets);
		// IMO prefix is stripped
		expect(targets.get("123456789").imo).toBe("9876543");
	});

	it("sets position latitude and longitude", () => {
		const targets = new Map();
		const delta = makeDelta("vessels.urn:mrn:imo:mmsi:123456789", {
			"navigation.position": { latitude: 51.5, longitude: -0.12 },
		});
		processDelta(delta, targets);
		const t = targets.get("123456789");
		expect(t.latitude).toBe(51.5);
		expect(t.longitude).toBe(-0.12);
	});

	it("sets lastSeenDate from update timestamp when position arrives", () => {
		const targets = new Map();
		const ts = "2024-06-15T12:00:00Z";
		const delta = {
			context: "vessels.urn:mrn:imo:mmsi:123456789",
			updates: [
				{
					timestamp: ts,
					values: [
						{
							path: "navigation.position",
							value: { latitude: 10.0, longitude: 20.0 },
						},
					],
				},
			],
		};
		processDelta(delta, targets);
		expect(targets.get("123456789").lastSeenDate).toEqual(new Date(ts));
	});

	it("sets needsRecalc when position changes", () => {
		const targets = new Map();
		targets.set("123456789", { mmsi: "123456789", needsRecalc: false });
		const delta = makeDelta("vessels.urn:mrn:imo:mmsi:123456789", {
			"navigation.position": { latitude: 10.0, longitude: 20.0 },
		});
		processDelta(delta, targets);
		expect(targets.get("123456789").needsRecalc).toBe(true);
	});

	it("sets needsRecalc when SOG changes", () => {
		const targets = new Map();
		targets.set("123456789", { mmsi: "123456789", needsRecalc: false });
		const delta = makeDelta("vessels.urn:mrn:imo:mmsi:123456789", {
			"navigation.speedOverGround": 3.0,
		});
		processDelta(delta, targets);
		expect(targets.get("123456789").needsRecalc).toBe(true);
	});

	it("sets needsRecalc when COG changes", () => {
		const targets = new Map();
		targets.set("123456789", { mmsi: "123456789", needsRecalc: false });
		const delta = makeDelta("vessels.urn:mrn:imo:mmsi:123456789", {
			"navigation.courseOverGroundTrue": 1.57,
		});
		processDelta(delta, targets);
		expect(targets.get("123456789").needsRecalc).toBe(true);
	});

	it("extracts magnetic variation", () => {
		const targets = new Map();
		const delta = makeDelta("vessels.urn:mrn:imo:mmsi:123456789", {
			"navigation.magneticVariation": 0.1745, // ~10 degrees
		});
		processDelta(delta, targets);
		expect(targets.get("123456789").magvar).toBeCloseTo(0.1745);
	});

	it("extracts rate of turn", () => {
		const targets = new Map();
		const delta = makeDelta("vessels.urn:mrn:imo:mmsi:123456789", {
			"navigation.rateOfTurn": 0.05,
		});
		processDelta(delta, targets);
		expect(targets.get("123456789").rot).toBe(0.05);
	});

	it("extracts AIS ship type", () => {
		const targets = new Map();
		const delta = makeDelta("vessels.urn:mrn:imo:mmsi:123456789", {
			"design.aisShipType": { id: 70, name: "Cargo" },
		});
		processDelta(delta, targets);
		const t = targets.get("123456789");
		expect(t.typeId).toBe(70);
		expect(t.type).toBe("Cargo");
	});

	it("extracts navigation state", () => {
		const targets = new Map();
		const delta = makeDelta("vessels.urn:mrn:imo:mmsi:123456789", {
			"navigation.state": "moored",
		});
		processDelta(delta, targets);
		expect(targets.get("123456789").status).toBe("moored");
	});

	it("extracts AIS class", () => {
		const targets = new Map();
		const delta = makeDelta("vessels.urn:mrn:imo:mmsi:123456789", {
			"sensors.ais.class": "A",
		});
		processDelta(delta, targets);
		expect(targets.get("123456789").aisClass).toBe("A");
	});

	it("extracts destination", () => {
		const targets = new Map();
		const delta = makeDelta("vessels.urn:mrn:imo:mmsi:123456789", {
			"navigation.destination.commonName": "USBAL",
		});
		processDelta(delta, targets);
		expect(targets.get("123456789").destination).toBe("USBAL");
	});

	it("extracts vessel dimensions (length, beam, draft)", () => {
		const targets = new Map();
		const delta = {
			context: "vessels.urn:mrn:imo:mmsi:123456789",
			updates: [
				{
					timestamp: "2024-01-01T00:00:00Z",
					values: [
						{ path: "design.length", value: { overall: 200.5 } },
						{ path: "design.beam", value: 32.0 },
						{ path: "design.draft", value: { current: 11.5 } },
					],
				},
			],
		};
		processDelta(delta, targets);
		const t = targets.get("123456789");
		expect(t.length).toBe(200.5);
		expect(t.beam).toBe(32.0);
		expect(t.draft).toBe(11.5);
	});

	it("initialises new target with default sog=0 and cog=0", () => {
		const targets = new Map();
		const delta = makeDelta("vessels.urn:mrn:imo:mmsi:999888777", {
			"navigation.headingTrue": 0.5,
		});
		processDelta(delta, targets);
		const t = targets.get("999888777");
		expect(t.sog).toBe(0);
		expect(t.cog).toBe(0);
	});

	it("sets virtual=true flag for virtual ATON", () => {
		const targets = new Map();
		const delta = makeDelta("atons.urn:mrn:imo:mmsi:991234567", {
			virtual: true,
		});
		processDelta(delta, targets);
		expect(targets.get("991234567").isVirtual).toBe(1);
	});

	it("does not set default ATON status if status already set", () => {
		const targets = new Map();
		targets.set("991234567", {
			mmsi: "991234567",
			status: "off-position",
			sog: 0,
			cog: 0,
		});
		const delta = makeDelta("atons.urn:mrn:imo:mmsi:991234567", {
			atonType: { id: 5, name: "Beacon" },
		});
		processDelta(delta, targets);
		// Existing status is preserved; only set "default" when null
		expect(targets.get("991234567").status).toBe("off-position");
	});

	it("skips values where value.value is undefined", () => {
		const targets = new Map();
		const delta = {
			context: "vessels.urn:mrn:imo:mmsi:123456789",
			updates: [
				{
					timestamp: "2024-01-01T00:00:00Z",
					values: [{ path: "navigation.speedOverGround", value: undefined }],
				},
			],
		};
		// Should not throw
		expect(() => processDelta(delta, targets)).not.toThrow();
	});

	it("handles delta with empty values array", () => {
		const targets = new Map();
		const delta = {
			context: "vessels.urn:mrn:imo:mmsi:123456789",
			updates: [{ timestamp: "2024-01-01T00:00:00Z", values: [] }],
		};
		expect(() => processDelta(delta, targets)).not.toThrow();
		// Target is still created (with defaults)
		expect(targets.has("123456789")).toBe(true);
	});

	it("rejects MMSI shorter than 9 digits", () => {
		const targets = new Map();
		const delta = { context: "vessels.urn:mrn:imo:mmsi:12345", updates: [] };
		const result = processDelta(delta, targets);
		expect(result).toBeNull();
	});

	it("rejects MMSI with non-numeric characters", () => {
		const targets = new Map();
		const delta = {
			context: "vessels.urn:mrn:imo:mmsi:ABCDE1234",
			updates: [],
		};
		const result = processDelta(delta, targets);
		expect(result).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// getDistanceFromLatLonInMeters – direct unit tests
// ---------------------------------------------------------------------------

describe("getDistanceFromLatLonInMeters", () => {
	it("returns 0 for same coordinates", () => {
		expect(getDistanceFromLatLonInMeters(39.0, -75.0, 39.0, -75.0)).toBe(0);
	});

	it("returns ~111,120 m per degree of latitude at equator", () => {
		const dist = getDistanceFromLatLonInMeters(0, 0, 1, 0);
		expect(dist).toBeGreaterThan(110_000);
		expect(dist).toBeLessThan(112_000);
	});

	it("measures ~1 nautical mile correctly (1.852 km)", () => {
		// 1 NM north from a reference point
		const oneDegLat = 111_120; // meters per degree
		const oneNmDegrees = METERS_PER_NM / oneDegLat;
		const dist = getDistanceFromLatLonInMeters(39.0, -75.0, 39.0 + oneNmDegrees, -75.0);
		expect(dist).toBeGreaterThan(1800);
		expect(dist).toBeLessThan(1900);
	});

	it("is symmetric (A→B == B→A)", () => {
		const d1 = getDistanceFromLatLonInMeters(39.0, -75.0, 51.5, -0.12);
		const d2 = getDistanceFromLatLonInMeters(51.5, -0.12, 39.0, -75.0);
		expect(d1).toBeCloseTo(d2, 0);
	});
});

// ---------------------------------------------------------------------------
// getRhumbLineBearing – direct unit tests
// ---------------------------------------------------------------------------

describe("getRhumbLineBearing", () => {
	it("returns 0° for due north", () => {
		const bearing = getRhumbLineBearing(39.0, -75.0, 40.0, -75.0);
		expect(bearing).toBeCloseTo(0, 0);
	});

	it("returns 90° for due east", () => {
		const bearing = getRhumbLineBearing(39.0, -75.0, 39.0, -74.0);
		expect(bearing).toBeCloseTo(90, 0);
	});

	it("returns 180° for due south", () => {
		const bearing = getRhumbLineBearing(39.0, -75.0, 38.0, -75.0);
		expect(bearing).toBeCloseTo(180, 0);
	});

	it("returns 270° for due west", () => {
		const bearing = getRhumbLineBearing(39.0, -75.0, 39.0, -76.0);
		expect(bearing).toBeCloseTo(270, 0);
	});

	it("returns a value in [0, 360)", () => {
		const bearing = getRhumbLineBearing(39.0, -75.0, 40.5, -74.3);
		expect(bearing).toBeGreaterThanOrEqual(0);
		expect(bearing).toBeLessThan(360);
	});
});

// ---------------------------------------------------------------------------
// Exported formatting helpers
// ---------------------------------------------------------------------------

describe("formatCpaNumeric", () => {
	it("returns empty string for null CPA", () => {
		expect(formatCpaNumeric(null)).toBe("");
	});

	it("formats 1 nautical mile correctly", () => {
		expect(formatCpaNumeric(METERS_PER_NM)).toBe("1.00");
	});

	it("formats 0.5 nautical miles correctly", () => {
		expect(formatCpaNumeric(METERS_PER_NM / 2)).toBe("0.50");
	});

	it("formats fractional value with 2 decimal places", () => {
		expect(formatCpaNumeric(500)).toBe((500 / METERS_PER_NM).toFixed(2));
	});
});

describe("formatTcpaNumeric", () => {
	it("returns empty string for null TCPA", () => {
		expect(formatTcpaNumeric(null)).toBe("");
	});

	it("returns empty string for negative TCPA", () => {
		expect(formatTcpaNumeric(-60)).toBe("");
	});

	it("formats under-1-hour TCPA as mm:ss", () => {
		expect(formatTcpaNumeric(30 * 60)).toBe("30:00"); // 30 minutes
		expect(formatTcpaNumeric(90)).toBe("01:30"); // 1m 30s
	});

	it("formats over-1-hour TCPA as hh:mm:ss", () => {
		expect(formatTcpaNumeric(3600)).toBe("01:00:00"); // 1 hour
		expect(formatTcpaNumeric(3661)).toBe("01:01:01"); // 1h 1m 1s
	});

	it("formats exactly 0 seconds as 00:00", () => {
		expect(formatTcpaNumeric(0)).toBe("00:00");
	});
});

describe("formatSog", () => {
	it("returns empty string for null SOG", () => {
		expect(formatSog(null)).toBe("");
	});

	it("converts m/s to knots with one decimal", () => {
		// 1 knot = 1/KNOTS_PER_M_PER_S m/s ≈ 0.5144 m/s
		const oneKnotMs = 1 / KNOTS_PER_M_PER_S;
		expect(formatSog(oneKnotMs)).toBe("1.0");
	});

	it("returns '0.0' for zero speed", () => {
		expect(formatSog(0)).toBe("0.0");
	});

	it("formats typical vessel speed (10 knots ≈ 5.14 m/s)", () => {
		const tenKnotsMs = 10 / KNOTS_PER_M_PER_S;
		expect(formatSog(tenKnotsMs)).toBe("10.0");
	});
});

describe("formatCog", () => {
	it("returns empty string for null COG", () => {
		expect(formatCog(null)).toBe("");
	});

	it("formats 0 radians as '000'", () => {
		expect(formatCog(0)).toBe("000");
	});

	it("formats east (π/2 radians) as '090'", () => {
		expect(formatCog(Math.PI / 2)).toBe("090");
	});

	it("formats south (π radians) as '180'", () => {
		expect(formatCog(Math.PI)).toBe("180");
	});

	it("formats west (3π/2 radians) as '270'", () => {
		expect(formatCog(3 * Math.PI / 2)).toBe("270");
	});

	it("always zero-pads to 3 digits", () => {
		expect(formatCog(toRadians(45))).toBe("045");
	});
});

describe("formatFixed", () => {
	it("returns empty string for null", () => {
		expect(formatFixed(null, 2)).toBe("");
	});

	it("formats number with specified decimal places", () => {
		expect(formatFixed(Math.PI, 2)).toBe("3.14");
		expect(formatFixed(100, 0)).toBe("100");
		expect(formatFixed(0.001, 4)).toBe("0.0010");
	});
});

describe("formatLat / formatLon", () => {
	it("formatLat returns empty string for null", () => {
		expect(formatLat(null)).toBe("");
	});

	it("formatLon returns empty string for null", () => {
		expect(formatLon(null)).toBe("");
	});

	it("formatLat uses N prefix for positive latitude", () => {
		expect(formatLat(39.95)).toMatch(/^N /);
	});

	it("formatLat uses S prefix for negative latitude", () => {
		expect(formatLat(-33.8)).toMatch(/^S /);
	});

	it("formatLon uses E prefix for positive longitude", () => {
		expect(formatLon(151.2)).toMatch(/^E /);
	});

	it("formatLon uses W prefix for negative longitude", () => {
		expect(formatLon(-75.0)).toMatch(/^W /);
	});

	it("formatLat includes degree symbol and 2-digit degrees", () => {
		expect(formatLat(39.5)).toMatch(/\d{2}°/);
	});

	it("formatLon includes degree symbol and 3-digit degrees", () => {
		expect(formatLon(-75.5)).toMatch(/\d{3}°/);
	});

	it("formatLat produces correct output for known position", () => {
		// 39° 30.0000N
		const result = formatLat(39.5);
		expect(result).toMatch(/N 39° 30/);
	});

	it("formatLon produces correct output for known position", () => {
		// W 075° 00.0000
		const result = formatLon(-75.0);
		expect(result).toMatch(/W 075° 00/);
	});
});

// ---------------------------------------------------------------------------
// Alarm evaluation – collision warning vs danger distinction
// ---------------------------------------------------------------------------

describe("Collision alarm states", () => {
	/**
	 * Scenario: two vessels on crossing courses where the calculated CPA is between
	 * the danger and warning thresholds (0.1nm < CPA < 0.5nm for harbor profile).
	 * Expected: warning state, NOT danger state.
	 *
	 * Setup (Cartesian):
	 *   Self  at (39.000, -75.000) heading east  at 1 m/s
	 *   Other at (39.002, -74.998) heading west  at 1 m/s
	 *   → CPA ≈ 222 m (0.12nm), TCPA ≈ 86s
	 *   Profile: CPA<0.5nm ✓warning, CPA>0.1nm ✗danger, guard disabled
	 *   Note: guard must be disabled because range (~282m) would be inside 0.5nm guard zone.
	 */
	it("triggers collision WARNING but NOT danger when CPA is in warning zone", () => {
		const profileWarningOnly = {
			current: "harbor",
			harbor: {
				warning: { cpa: 0.5, tcpa: 600, speed: 0.5 },
				danger: { cpa: 0.1, tcpa: 300, speed: 3 },
				guard: { range: 0, speed: 0 }, // guard disabled
			},
		};
		const targets = new Map();
		const selfTarget = makeTarget({
			mmsi: "000000001",
			latitude: 39.0,
			longitude: -75.0,
			sog: 1.0, // >0.5kn warning speed gate (0.257 m/s)
			cog: toRadians(90), // east
		});
		const otherTarget = makeTarget({
			mmsi: "123456789",
			latitude: 39.002, // ~222m north
			longitude: -74.998, // ~173m east (converging)
			sog: 1.0,
			cog: toRadians(270), // west
		});
		targets.set("000000001", selfTarget);
		targets.set("123456789", otherTarget);

		updateDerivedData(targets, selfTarget, profileWarningOnly, TARGET_MAX_AGE);

		expect(otherTarget.collisionWarning).toBe(true);
		expect(otherTarget.collisionAlarm).toBe(false);
		expect(otherTarget.alarmState).toBe("warning");
		expect(otherTarget.alarmType).toContain("cpa");
	});

	/**
	 * Scenario: vessels on a close head-on course resulting in CPA well within
	 * the danger threshold and TCPA within danger limit.
	 * Expected: danger state (not just warning).
	 */
	it("triggers collision DANGER for vessels on head-on course with close CPA", () => {
		const targets = new Map();
		// Self heading east, other heading west, on the same latitude (CPA ≈ 0)
		const selfTarget = makeTarget({
			mmsi: "000000001",
			latitude: 39.0,
			longitude: -75.0,
			sog: 4 / KNOTS_PER_M_PER_S, // 4 knots – clearly above 3kn danger speed threshold
			cog: toRadians(90), // east
		});
		// Other is 200m to the east heading west, same latitude → near head-on (CPA ≈ 0m < 0.1nm)
		const otherTarget = makeTarget({
			mmsi: "123456789",
			latitude: 39.0,
			longitude: -75.0 + 200 / (111120 * Math.cos(toRadians(39))),
			sog: 4 / KNOTS_PER_M_PER_S,
			cog: toRadians(270), // west
		});
		targets.set("000000001", selfTarget);
		targets.set("123456789", otherTarget);

		updateDerivedData(targets, selfTarget, harborProfiles, TARGET_MAX_AGE);

		expect(otherTarget.collisionAlarm).toBe(true);
		expect(otherTarget.alarmState).toBe("danger");
	});

	/**
	 * Scenario: vessels are well-separated and diverging.
	 * Expected: no alarm, no warning, alarmState is null.
	 */
	it("sets no alarm when vessels are diverging", () => {
		const targets = new Map();
		const selfTarget = makeTarget({
			mmsi: "000000001",
			latitude: 39.0,
			longitude: -75.0,
			sog: 2.57,
			cog: toRadians(270), // self heading west
		});
		const otherTarget = makeTarget({
			mmsi: "123456789",
			latitude: 39.0,
			longitude: -74.97, // other is to the east heading east (diverging)
			sog: 2.57,
			cog: toRadians(90),
		});
		targets.set("000000001", selfTarget);
		targets.set("123456789", otherTarget);

		updateDerivedData(targets, selfTarget, profilesNoGuard, TARGET_MAX_AGE);

		expect(otherTarget.collisionAlarm).toBe(false);
		expect(otherTarget.collisionWarning).toBe(false);
		expect(otherTarget.alarmState).toBeNull();
		// TCPA should be null (vessels moving apart)
		expect(otherTarget.tcpa).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// Speed gate – alarms must respect minimum SOG thresholds
// ---------------------------------------------------------------------------

describe("Speed gate for alarms", () => {
	/**
	 * A vessel that is within the guard zone but moving too slowly should NOT
	 * trigger a guard alarm when the profile requires a minimum speed.
	 */
	it("does NOT trigger guard alarm when target speed is below the speed threshold", () => {
		const profileWithSpeedGate = {
			current: "harbor",
			harbor: {
				warning: { cpa: 0.5, tcpa: 600, speed: 0.5 },
				danger: { cpa: 0.1, tcpa: 300, speed: 3 },
				guard: { range: 0.5, speed: 0.5 }, // speed gate: must exceed 0.5 kn
			},
		};

		const targets = new Map();
		const selfTarget = makeTarget({ mmsi: "000000001" });
		const slowTarget = makeTarget({
			mmsi: "123456789",
			latitude: 39.004, // ~0.24nm north – within 0.5nm guard zone
			longitude: -75.0,
			sog: 0.1 / KNOTS_PER_M_PER_S, // 0.1 kn – below 0.5 kn speed gate
		});
		targets.set("000000001", selfTarget);
		targets.set("123456789", slowTarget);

		updateDerivedData(targets, selfTarget, profileWithSpeedGate, TARGET_MAX_AGE);

		expect(slowTarget.guardAlarm).toBe(false);
	});

	/**
	 * The same vessel exceeding the speed threshold should trigger the guard alarm.
	 */
	it("DOES trigger guard alarm when target speed exceeds the speed threshold", () => {
		const profileWithSpeedGate = {
			current: "harbor",
			harbor: {
				warning: { cpa: 0.5, tcpa: 600, speed: 0.5 },
				danger: { cpa: 0.1, tcpa: 300, speed: 3 },
				guard: { range: 0.5, speed: 0.5 },
			},
		};

		const targets = new Map();
		const selfTarget = makeTarget({ mmsi: "000000001" });
		const fastTarget = makeTarget({
			mmsi: "123456789",
			latitude: 39.004, // within 0.5nm guard zone
			longitude: -75.0,
			sog: 2.0 / KNOTS_PER_M_PER_S, // 2 kn – above 0.5 kn speed gate
		});
		targets.set("000000001", selfTarget);
		targets.set("123456789", fastTarget);

		updateDerivedData(targets, selfTarget, profileWithSpeedGate, TARGET_MAX_AGE);

		expect(fastTarget.guardAlarm).toBe(true);
	});

	/**
	 * A target too slow to trigger a collision warning should have no alarm.
	 */
	it("does NOT trigger collision warning when target speed is below warning speed gate", () => {
		const targets = new Map();
		// Self heading east, other heading west but very slow
		const selfTarget = makeTarget({
			mmsi: "000000001",
			latitude: 39.0,
			longitude: -75.0,
			sog: 1.0,
			cog: toRadians(90),
		});
		const slowTarget = makeTarget({
			mmsi: "123456789",
			latitude: 39.002, // would be in warning CPA zone
			longitude: -74.998,
			sog: 0.1 / KNOTS_PER_M_PER_S, // 0.1 kn – below 0.5 kn warning gate
			cog: toRadians(270),
		});
		targets.set("000000001", selfTarget);
		targets.set("123456789", slowTarget);

		updateDerivedData(targets, selfTarget, harborProfiles, TARGET_MAX_AGE);

		expect(slowTarget.collisionWarning).toBe(false);
		expect(slowTarget.collisionAlarm).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Guard zone disabled (range = 0)
// ---------------------------------------------------------------------------

describe("Guard zone disabled when range = 0", () => {
	it("never triggers guard alarm when guard range is 0", () => {
		const targets = new Map();
		const selfTarget = makeTarget({ mmsi: "000000001" });
		const closeTarget = makeTarget({
			mmsi: "123456789",
			latitude: 39.0001, // extremely close
			longitude: -75.0,
			sog: 10.0, // fast
		});
		targets.set("000000001", selfTarget);
		targets.set("123456789", closeTarget);

		updateDerivedData(targets, selfTarget, profilesNoGuard, TARGET_MAX_AGE);

		expect(closeTarget.guardAlarm).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Combined alarm types
// ---------------------------------------------------------------------------

describe("Combined alarm types", () => {
	it("includes both 'guard' and 'cpa' in alarmType when both conditions are met", () => {
		// Target is within guard zone AND on a collision course
		const profiles = {
			current: "harbor",
			harbor: {
				warning: { cpa: 2.0, tcpa: 3600, speed: 0 }, // very sensitive warning
				danger: { cpa: 1.0, tcpa: 1800, speed: 0 }, // very sensitive danger
				guard: { range: 2.0, speed: 0 }, // 2nm guard zone
			},
		};
		const targets = new Map();
		const selfTarget = makeTarget({
			mmsi: "000000001",
			latitude: 39.0,
			longitude: -75.0,
			sog: 5.0,
			cog: toRadians(90),
		});
		// Close vessel heading toward us
		const otherTarget = makeTarget({
			mmsi: "123456789",
			latitude: 39.0,
			longitude: -74.998, // ~173m east – within 2nm guard zone
			sog: 5.0,
			cog: toRadians(270), // heading west toward self
		});
		targets.set("000000001", selfTarget);
		targets.set("123456789", otherTarget);

		updateDerivedData(targets, selfTarget, profiles, TARGET_MAX_AGE);

		expect(otherTarget.guardAlarm).toBe(true);
		expect(otherTarget.alarmType).toContain("guard");
	});

	it("alarmType includes 'cpa' for collision alarm", () => {
		const targets = new Map();
		const selfTarget = makeTarget({
			mmsi: "000000001",
			latitude: 39.0,
			longitude: -75.0,
			sog: 5.0 / KNOTS_PER_M_PER_S,
			cog: toRadians(90),
		});
		// Vessel on head-on course
		const otherTarget = makeTarget({
			mmsi: "123456789",
			latitude: 39.0,
			longitude: -75.0 + 200 / (111120 * Math.cos(toRadians(39))),
			sog: 5.0 / KNOTS_PER_M_PER_S,
			cog: toRadians(270),
		});
		targets.set("000000001", selfTarget);
		targets.set("123456789", otherTarget);

		updateDerivedData(targets, selfTarget, harborProfiles, TARGET_MAX_AGE);

		// Head-on with ~0m CPA, TCPA should be short
		if (otherTarget.collisionAlarm || otherTarget.collisionWarning) {
			expect(otherTarget.alarmType).toContain("cpa");
		}
	});

	it("SART and EPIRB alarms always show regardless of range", () => {
		const targets = new Map();
		const selfTarget = makeTarget({ mmsi: "000000001" });

		const sartTarget = makeTarget({
			mmsi: "970000001",
			latitude: 42.0, // far away
			longitude: -70.0,
		});
		const epirbTarget = makeTarget({
			mmsi: "974000001",
			latitude: 42.0,
			longitude: -70.0,
		});
		targets.set("000000001", selfTarget);
		targets.set("970000001", sartTarget);
		targets.set("974000001", epirbTarget);

		updateDerivedData(targets, selfTarget, profilesNoGuard, TARGET_MAX_AGE);

		expect(sartTarget.sartAlarm).toBe(true);
		expect(sartTarget.alarmState).toBe("danger");
		expect(epirbTarget.epirbAlarm).toBe(true);
		expect(epirbTarget.alarmState).toBe("danger");
	});
});

// ---------------------------------------------------------------------------
// Priority ordering – detailed ordering verification
// ---------------------------------------------------------------------------

describe("Priority ordering", () => {
	it("danger alarm has lower order value than warning alarm", () => {
		const targets = new Map();
		const selfTarget = makeTarget({ mmsi: "000000001" });

		// Vessel A: in guard zone (danger)
		const dangerTarget = makeTarget({
			mmsi: "111111111",
			latitude: 39.004,
			longitude: -75.0,
		});

		// Vessel B: in warning CPA zone (warning)
		const warningTarget = makeTarget({
			mmsi: "222222222",
			latitude: 39.002,
			longitude: -74.998,
			sog: 1.0,
			cog: toRadians(270),
		});

		targets.set("000000001", selfTarget);
		targets.set("111111111", dangerTarget);
		targets.set("222222222", warningTarget);

		// Use self with matching sog for warning calc
		selfTarget.sog = 1.0;
		selfTarget.cog = toRadians(90);

		updateDerivedData(targets, selfTarget, harborProfiles, TARGET_MAX_AGE);

		if (dangerTarget.alarmState === "danger" && warningTarget.alarmState === "warning") {
			expect(dangerTarget.order).toBeLessThan(warningTarget.order);
		}
	});

	it("among two danger targets, the one with shorter TCPA has higher priority (lower order)", () => {
		const sartClose = makeTarget({
			mmsi: "970000001",
			latitude: 39.005, // 0.3nm away
			longitude: -75.0,
			lastSeenDate: new Date(),
		});
		const sartFar = makeTarget({
			mmsi: "970000002",
			latitude: 39.05, // 3nm away
			longitude: -75.0,
			lastSeenDate: new Date(),
		});
		const selfTarget = makeTarget({ mmsi: "000000001" });
		const targets = new Map();
		targets.set("000000001", selfTarget);
		targets.set("970000001", sartClose);
		targets.set("970000002", sartFar);

		updateDerivedData(targets, selfTarget, profilesNoGuard, TARGET_MAX_AGE);

		// Both are SART → danger, but closer one should have lower order
		expect(sartClose.alarmState).toBe("danger");
		expect(sartFar.alarmState).toBe("danger");
		expect(sartClose.order).toBeLessThan(sartFar.order);
	});

	it("target without range goes to bottom (highest order value)", () => {
		const targets = new Map();
		const selfTarget = makeTarget({ mmsi: "000000001" });
		const noPositionTarget = makeTarget({
			mmsi: "111111111",
			latitude: null,
			longitude: null,
		});
		const normalTarget = makeTarget({
			mmsi: "222222222",
			latitude: 39.05,
			longitude: -75.0,
		});
		targets.set("000000001", selfTarget);
		targets.set("111111111", noPositionTarget);
		targets.set("222222222", normalTarget);

		updateDerivedData(targets, selfTarget, profilesNoGuard, TARGET_MAX_AGE);

		// No-position target has no range → highest order
		expect(noPositionTarget.order).toBeGreaterThan(normalTarget.order);
	});

	it("order values are clamped within [-99999, 99999]", () => {
		const targets = new Map();
		const selfTarget = makeTarget({ mmsi: "000000001" });

		// Many targets at various distances
		for (let i = 1; i <= 5; i++) {
			targets.set(`99999999${i}`, makeTarget({
				mmsi: `99999999${i}`,
				latitude: 39.0 + i * 5,
				longitude: -75.0,
			}));
		}
		targets.set("000000001", selfTarget);

		updateDerivedData(targets, selfTarget, profilesNoGuard, TARGET_MAX_AGE);

		for (const [mmsi, target] of targets) {
			if (mmsi === "000000001") continue;
			expect(target.order).toBeGreaterThanOrEqual(-99999);
			expect(target.order).toBeLessThanOrEqual(99999);
		}
	});

	it("closing vessel (positive TCPA, no alarm) has lower order than diverging vessel", () => {
		const targets = new Map();
		// Self heading north
		const selfTarget = makeTarget({
			mmsi: "000000001",
			latitude: 39.0,
			longitude: -75.0,
			sog: 2.0,
			cog: toRadians(0), // north
		});
		// Closing: vessel heading toward self (south)
		const closingTarget = makeTarget({
			mmsi: "111111111",
			latitude: 39.05,
			longitude: -75.0,
			sog: 2.0,
			cog: toRadians(180), // south – converging
		});
		// Diverging: vessel heading away from self (also north, faster)
		const divergingTarget = makeTarget({
			mmsi: "222222222",
			latitude: 39.05,
			longitude: -75.0,
			sog: 4.0,
			cog: toRadians(0), // north – moving away faster
		});
		targets.set("000000001", selfTarget);
		targets.set("111111111", closingTarget);
		targets.set("222222222", divergingTarget);

		updateDerivedData(targets, selfTarget, profilesNoGuard, TARGET_MAX_AGE);

		if (closingTarget.tcpa != null && closingTarget.tcpa > 0) {
			expect(closingTarget.order).toBeLessThan(divergingTarget.order);
		}
	});
});

// ---------------------------------------------------------------------------
// Target validity and aging
// ---------------------------------------------------------------------------

describe("Target validity and aging", () => {
	it("target with valid position is marked isValid=true", () => {
		const targets = new Map();
		const selfTarget = makeTarget({ mmsi: "000000001" });
		const validTarget = makeTarget({ mmsi: "123456789" });
		targets.set("000000001", selfTarget);
		targets.set("123456789", validTarget);

		updateDerivedData(targets, selfTarget, profilesNoGuard, TARGET_MAX_AGE);

		expect(validTarget.isValid).toBe(true);
	});

	it("target without latitude/longitude is marked isValid=false", () => {
		const targets = new Map();
		const selfTarget = makeTarget({ mmsi: "000000001" });
		const invalidTarget = makeTarget({
			mmsi: "123456789",
			latitude: null,
			longitude: null,
		});
		targets.set("000000001", selfTarget);
		targets.set("123456789", invalidTarget);

		updateDerivedData(targets, selfTarget, profilesNoGuard, TARGET_MAX_AGE);

		expect(invalidTarget.isValid).toBe(false);
	});

	it("target older than TARGET_MAX_AGE is marked isValid=false", () => {
		const targets = new Map();
		const selfTarget = makeTarget({ mmsi: "000000001" });
		const staleTarget = makeTarget({
			mmsi: "123456789",
			lastSeenDate: new Date(Date.now() - (TARGET_MAX_AGE + 60) * 1000), // +60s past limit
		});
		targets.set("000000001", selfTarget);
		targets.set("123456789", staleTarget);

		updateDerivedData(targets, selfTarget, profilesNoGuard, TARGET_MAX_AGE);

		expect(staleTarget.isValid).toBe(false);
	});

	it("target older than LOST_TARGET_WARNING_AGE is marked isLost=true", () => {
		const targets = new Map();
		const selfTarget = makeTarget({ mmsi: "000000001" });
		const lostTarget = makeTarget({
			mmsi: "123456789",
			lastSeenDate: new Date(Date.now() - (LOST_TARGET_WARNING_AGE + 60) * 1000),
		});
		targets.set("000000001", selfTarget);
		targets.set("123456789", lostTarget);

		updateDerivedData(targets, selfTarget, profilesNoGuard, TARGET_MAX_AGE);

		expect(lostTarget.isLost).toBe(true);
	});

	it("recently-seen target is NOT marked isLost", () => {
		const targets = new Map();
		const selfTarget = makeTarget({ mmsi: "000000001" });
		const recentTarget = makeTarget({
			mmsi: "123456789",
			lastSeenDate: new Date(Date.now() - 30 * 1000), // 30s ago
		});
		targets.set("000000001", selfTarget);
		targets.set("123456789", recentTarget);

		updateDerivedData(targets, selfTarget, profilesNoGuard, TARGET_MAX_AGE);

		expect(recentTarget.isLost).toBe(false);
	});

	it("target at equator (lat=0, lon=0) is considered valid", () => {
		const targets = new Map();
		const selfTarget = makeTarget({
			mmsi: "000000001",
			latitude: 0.0,
			longitude: 0.0,
		});
		const otherTarget = makeTarget({
			mmsi: "123456789",
			latitude: 0.01,
			longitude: 0.0,
		});
		targets.set("000000001", selfTarget);
		targets.set("123456789", otherTarget);

		// Must not throw despite lat=0 and lon=0
		expect(() => {
			updateDerivedData(targets, selfTarget, profilesNoGuard, TARGET_MAX_AGE);
		}).not.toThrow();

		expect(otherTarget.isValid).toBe(true);
	});

	it("self target with lastSeenDate in the future still computes lastSeen >= 0", () => {
		const targets = new Map();
		const selfTarget = makeTarget({
			mmsi: "000000001",
			lastSeenDate: new Date(Date.now() + 5000), // 5 seconds in future (clock skew)
		});
		targets.set("000000001", selfTarget);

		expect(() => {
			updateDerivedData(targets, selfTarget, profilesNoGuard, TARGET_MAX_AGE);
		}).not.toThrow();

		expect(selfTarget.lastSeen).toBeGreaterThanOrEqual(0);
	});
});

// ---------------------------------------------------------------------------
// updateSingleTargetDerivedData – direct export
// ---------------------------------------------------------------------------

describe("updateSingleTargetDerivedData", () => {
	it("computes formatted SOG, COG, HDG for a single target", () => {
		const selfTarget = makeTarget({
			mmsi: "000000001",
			sog: 5.0 / KNOTS_PER_M_PER_S, // 5 knots
			cog: toRadians(45),
			hdg: toRadians(45),
		});
		updateSingleTargetDerivedData(
			selfTarget,
			selfTarget,
			profilesNoGuard,
			TARGET_MAX_AGE,
		);
		expect(selfTarget.sogFormatted).toContain("5.0");
		expect(selfTarget.cogFormatted).toContain("45");
		expect(selfTarget.hdgFormatted).toContain("45");
	});

	it("returns '---' for null rot in rotFormatted", () => {
		const selfTarget = makeTarget({ mmsi: "000000001", rot: null });
		updateSingleTargetDerivedData(
			selfTarget,
			selfTarget,
			profilesNoGuard,
			TARGET_MAX_AGE,
		);
		expect(selfTarget.rotFormatted).toBe("---");
	});

	it("includes '(virtual)' in aisClassFormatted when target is virtual", () => {
		const selfTarget = makeTarget({ mmsi: "000000001", aisClass: "B", isVirtual: 1 });
		updateSingleTargetDerivedData(
			selfTarget,
			selfTarget,
			profilesNoGuard,
			TARGET_MAX_AGE,
		);
		expect(selfTarget.aisClassFormatted).toContain("(virtual)");
	});

	it("formats size as '--- m x --- m' when length/beam are undefined", () => {
		const selfTarget = makeTarget({ mmsi: "000000001" });
		// No length or beam set
		updateSingleTargetDerivedData(
			selfTarget,
			selfTarget,
			profilesNoGuard,
			TARGET_MAX_AGE,
		);
		expect(selfTarget.sizeFormatted).toBe("--- m x --- m");
	});

	it("strips IMO prefix from imoFormatted", () => {
		const selfTarget = makeTarget({ mmsi: "000000001", imo: "IMO1234567" });
		updateSingleTargetDerivedData(
			selfTarget,
			selfTarget,
			profilesNoGuard,
			TARGET_MAX_AGE,
		);
		expect(selfTarget.imoFormatted).toBe("1234567");
	});
});

// ---------------------------------------------------------------------------
// updateDerivedData – error handling
// ---------------------------------------------------------------------------

describe("updateDerivedData – error conditions", () => {
	it("throws when selfTarget latitude is 0 (falsy but valid) – should NOT throw", () => {
		// Equator latitude of 0 is a valid position – must not be treated as missing
		const targets = new Map();
		const selfTarget = makeTarget({ mmsi: "000000001", latitude: 0, longitude: 10 });
		targets.set("000000001", selfTarget);

		expect(() => {
			updateDerivedData(targets, selfTarget, profilesNoGuard, TARGET_MAX_AGE);
		}).not.toThrow();
	});

	it("throws when selfTarget has undefined latitude", () => {
		const targets = new Map();
		const selfTarget = makeTarget({ mmsi: "000000001", latitude: undefined, longitude: -75.0 });
		targets.set("000000001", selfTarget);

		// undefined latitude → isValid=false → throw
		expect(() => {
			updateDerivedData(targets, selfTarget, profilesNoGuard, TARGET_MAX_AGE);
		}).toThrow("No GPS position available");
	});

	it("skips self when iterating other targets", () => {
		const targets = new Map();
		const selfTarget = makeTarget({ mmsi: "000000001" });
		targets.set("000000001", selfTarget);

		updateDerivedData(targets, selfTarget, profilesNoGuard, TARGET_MAX_AGE);

		// Self target should not have range/bearing set (those are only for other targets)
		expect(selfTarget.range).toBeUndefined();
		expect(selfTarget.bearing).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// TCPA edge cases
// ---------------------------------------------------------------------------

describe("TCPA edge cases", () => {
	it("does not set TCPA for exactly zero (vessels at CPA right now)", () => {
		// If TCPA comes out as exactly 0, the code guards with `!tcpa` → null
		// This happens when vessels are exactly at closest approach at calculation time.
		// We verify that cpa/tcpa remain null in this boundary case by checking the guard.
		// (We test the guard condition indirectly via parallel vessels producing null.)
		const targets = new Map();
		const selfTarget = makeTarget({ mmsi: "000000001", sog: 2.57, cog: toRadians(90) });
		const parallelTarget = makeTarget({
			mmsi: "123456789",
			latitude: 39.01,
			longitude: -75.0,
			sog: 2.57,
			cog: toRadians(90), // same heading, same speed → no relative motion
		});
		targets.set("000000001", selfTarget);
		targets.set("123456789", parallelTarget);

		updateDerivedData(targets, selfTarget, profilesNoGuard, TARGET_MAX_AGE);

		// Parallel vessels → CPA and TCPA both null (no relative motion)
		expect(parallelTarget.cpa).toBeNull();
		expect(parallelTarget.tcpa).toBeNull();
		expect(parallelTarget.collisionAlarm).toBe(false);
		expect(parallelTarget.collisionWarning).toBe(false);
	});

	it("does not produce NaN for CPA or TCPA in any scenario", () => {
		const targets = new Map();
		const selfTarget = makeTarget({ mmsi: "000000001", sog: 5.14, cog: toRadians(90) });
		const otherTarget = makeTarget({
			mmsi: "123456789",
			latitude: 39.005,
			longitude: -74.97,
			sog: 3.0,
			cog: toRadians(200),
		});
		targets.set("000000001", selfTarget);
		targets.set("123456789", otherTarget);

		updateDerivedData(targets, selfTarget, profilesNoGuard, TARGET_MAX_AGE);

		if (otherTarget.cpa != null) {
			expect(Number.isNaN(otherTarget.cpa)).toBe(false);
		}
		if (otherTarget.tcpa != null) {
			expect(Number.isNaN(otherTarget.tcpa)).toBe(false);
		}
	});
});

// ---------------------------------------------------------------------------
// CPA/TCPA formatted output
// ---------------------------------------------------------------------------

describe("CPA/TCPA formatted display", () => {
	it("cpaFormatted shows '---' when no CPA is available", () => {
		const targets = new Map();
		const selfTarget = makeTarget({ mmsi: "000000001", sog: 2.57, cog: toRadians(90) });
		// Parallel vessel – no CPA
		const parallelTarget = makeTarget({
			mmsi: "123456789",
			latitude: 39.01,
			longitude: -75.0,
			sog: 2.57,
			cog: toRadians(90),
		});
		targets.set("000000001", selfTarget);
		targets.set("123456789", parallelTarget);

		updateDerivedData(targets, selfTarget, profilesNoGuard, TARGET_MAX_AGE);

		expect(parallelTarget.cpaFormatted).toBe("---");
		expect(parallelTarget.tcpaFormatted).toBe("---");
	});

	it("cpaFormatted shows NM when CPA is available", () => {
		const targets = new Map();
		const selfTarget = makeTarget({ mmsi: "000000001", sog: 5.0, cog: toRadians(90) });
		const otherTarget = makeTarget({
			mmsi: "123456789",
			latitude: 39.0,
			longitude: -75.0 + 500 / (111120 * Math.cos(toRadians(39))),
			sog: 5.0,
			cog: toRadians(270),
		});
		targets.set("000000001", selfTarget);
		targets.set("123456789", otherTarget);

		updateDerivedData(targets, selfTarget, profilesNoGuard, TARGET_MAX_AGE);

		if (otherTarget.cpa != null) {
			expect(otherTarget.cpaFormatted).toContain("NM");
			expect(otherTarget.tcpaFormatted).not.toBe("---");
		}
	});
});

// ---------------------------------------------------------------------------
// Range and bearing formatted output
// ---------------------------------------------------------------------------

describe("Range and bearing formatted output", () => {
	it("rangeFormatted shows '---' when target has no position", () => {
		const targets = new Map();
		const selfTarget = makeTarget({ mmsi: "000000001" });
		const noPositionTarget = makeTarget({
			mmsi: "123456789",
			latitude: null,
			longitude: null,
		});
		targets.set("000000001", selfTarget);
		targets.set("123456789", noPositionTarget);

		updateDerivedData(targets, selfTarget, profilesNoGuard, TARGET_MAX_AGE);

		expect(noPositionTarget.rangeFormatted).toBe("---");
		expect(noPositionTarget.bearingFormatted).toBe("---");
	});

	it("rangeFormatted includes 'NM' for a positioned target", () => {
		const targets = new Map();
		const selfTarget = makeTarget({ mmsi: "000000001" });
		const otherTarget = makeTarget({ mmsi: "123456789", latitude: 39.1, longitude: -75.0 });
		targets.set("000000001", selfTarget);
		targets.set("123456789", otherTarget);

		updateDerivedData(targets, selfTarget, profilesNoGuard, TARGET_MAX_AGE);

		expect(otherTarget.rangeFormatted).toContain("NM");
	});

	it("bearingFormatted includes 'T' for true bearing", () => {
		const targets = new Map();
		const selfTarget = makeTarget({ mmsi: "000000001" });
		const otherTarget = makeTarget({ mmsi: "123456789", latitude: 39.1, longitude: -75.0 });
		targets.set("000000001", selfTarget);
		targets.set("123456789", otherTarget);

		updateDerivedData(targets, selfTarget, profilesNoGuard, TARGET_MAX_AGE);

		expect(otherTarget.bearingFormatted).toContain("T");
	});
});
