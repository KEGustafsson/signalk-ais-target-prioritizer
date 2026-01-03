import { describe, it, expect, beforeEach } from "vitest";
import { updateDerivedData, toRadians, toDegrees } from "./ais-utils.mjs";

describe("ais-utils", () => {
	describe("toRadians / toDegrees", () => {
		it("should convert degrees to radians", () => {
			expect(toRadians(0)).toBe(0);
			expect(toRadians(180)).toBeCloseTo(Math.PI, 10);
			expect(toRadians(90)).toBeCloseTo(Math.PI / 2, 10);
			expect(toRadians(360)).toBeCloseTo(2 * Math.PI, 10);
		});

		it("should convert radians to degrees", () => {
			expect(toDegrees(0)).toBe(0);
			expect(toDegrees(Math.PI)).toBeCloseTo(180, 10);
			expect(toDegrees(Math.PI / 2)).toBeCloseTo(90, 10);
			expect(toDegrees(2 * Math.PI)).toBeCloseTo(360, 10);
		});

		it("should be inverse operations", () => {
			const degrees = 45;
			expect(toDegrees(toRadians(degrees))).toBeCloseTo(degrees, 10);
		});
	});

	describe("CPA/TCPA calculations", () => {
		const TARGET_MAX_AGE = 30 * 60;
		const collisionProfiles = {
			current: "harbor",
			harbor: {
				warning: { cpa: 0.5, tcpa: 600, speed: 0.5 },
				danger: { cpa: 0.1, tcpa: 300, speed: 3 },
				guard: { range: 0, speed: 0 },
			},
		};

		function createTarget(overrides = {}) {
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

		it("should calculate range for two vessels", () => {
			const targets = new Map();
			const selfTarget = createTarget({ mmsi: "000000001", latitude: 39.0, longitude: -75.0 });
			const otherTarget = createTarget({
				mmsi: "123456789",
				latitude: 39.01, // ~1.1km north
				longitude: -75.0,
			});

			targets.set("000000001", selfTarget);
			targets.set("123456789", otherTarget);

			updateDerivedData(targets, selfTarget, collisionProfiles, TARGET_MAX_AGE);

			// ~1.1km = ~0.6nm, should be around 1111m
			expect(otherTarget.range).toBeGreaterThan(1000);
			expect(otherTarget.range).toBeLessThan(1200);
		});

		it("should calculate bearing correctly - target due north", () => {
			const targets = new Map();
			const selfTarget = createTarget({ mmsi: "000000001", latitude: 39.0, longitude: -75.0 });
			const otherTarget = createTarget({
				mmsi: "123456789",
				latitude: 39.1, // north
				longitude: -75.0,
			});

			targets.set("000000001", selfTarget);
			targets.set("123456789", otherTarget);

			updateDerivedData(targets, selfTarget, collisionProfiles, TARGET_MAX_AGE);

			// Bearing should be close to 0 (north)
			expect(otherTarget.bearing).toBeGreaterThanOrEqual(0);
			expect(otherTarget.bearing).toBeLessThan(5);
		});

		it("should calculate bearing correctly - target due east", () => {
			const targets = new Map();
			const selfTarget = createTarget({ mmsi: "000000001", latitude: 39.0, longitude: -75.0 });
			const otherTarget = createTarget({
				mmsi: "123456789",
				latitude: 39.0,
				longitude: -74.9, // east
			});

			targets.set("000000001", selfTarget);
			targets.set("123456789", otherTarget);

			updateDerivedData(targets, selfTarget, collisionProfiles, TARGET_MAX_AGE);

			// Bearing should be close to 90 (east)
			expect(otherTarget.bearing).toBeGreaterThan(85);
			expect(otherTarget.bearing).toBeLessThan(95);
		});

		it("should calculate CPA/TCPA for converging vessels", () => {
			const targets = new Map();

			// Self vessel heading east at 5 knots (2.57 m/s)
			const selfTarget = createTarget({
				mmsi: "000000001",
				latitude: 39.0,
				longitude: -75.0,
				sog: 2.57, // ~5 knots in m/s
				cog: toRadians(90), // heading east
			});

			// Other vessel heading west at 5 knots, 2nm to the east
			const otherTarget = createTarget({
				mmsi: "123456789",
				latitude: 39.0,
				longitude: -74.96, // ~2nm east
				sog: 2.57,
				cog: toRadians(270), // heading west
			});

			targets.set("000000001", selfTarget);
			targets.set("123456789", otherTarget);

			updateDerivedData(targets, selfTarget, collisionProfiles, TARGET_MAX_AGE);

			// Should have a CPA close to 0 (head-on collision course)
			expect(otherTarget.cpa).toBeDefined();
			expect(otherTarget.cpa).toBeLessThan(100); // within 100m

			// TCPA should be positive (vessels approaching)
			expect(otherTarget.tcpa).toBeDefined();
			expect(otherTarget.tcpa).toBeGreaterThan(0);
		});

		it("should calculate CPA/TCPA for parallel vessels (no collision)", () => {
			const targets = new Map();

			// Self vessel heading east at 5 knots
			const selfTarget = createTarget({
				mmsi: "000000001",
				latitude: 39.0,
				longitude: -75.0,
				sog: 2.57,
				cog: toRadians(90), // heading east
			});

			// Other vessel also heading east at same speed, 1nm north (parallel)
			const otherTarget = createTarget({
				mmsi: "123456789",
				latitude: 39.016, // ~1nm north
				longitude: -75.0,
				sog: 2.57,
				cog: toRadians(90), // also heading east
			});

			targets.set("000000001", selfTarget);
			targets.set("123456789", otherTarget);

			updateDerivedData(targets, selfTarget, collisionProfiles, TARGET_MAX_AGE);

			// CPA/TCPA should be null for parallel vessels with no relative motion
			expect(otherTarget.cpa).toBeNull();
			expect(otherTarget.tcpa).toBeNull();
		});

		it("should calculate CPA/TCPA for diverging vessels", () => {
			const targets = new Map();

			// Self vessel heading east
			const selfTarget = createTarget({
				mmsi: "000000001",
				latitude: 39.0,
				longitude: -75.0,
				sog: 2.57,
				cog: toRadians(90), // heading east
			});

			// Other vessel heading east but further east (moving away)
			const otherTarget = createTarget({
				mmsi: "123456789",
				latitude: 39.0,
				longitude: -74.96,
				sog: 5.14, // faster, moving away
				cog: toRadians(90), // also heading east
			});

			targets.set("000000001", selfTarget);
			targets.set("123456789", otherTarget);

			updateDerivedData(targets, selfTarget, collisionProfiles, TARGET_MAX_AGE);

			// TCPA should be null (vessels diverging, CPA in the past)
			expect(otherTarget.tcpa).toBeNull();
		});
	});

	describe("Alarm evaluation", () => {
		const TARGET_MAX_AGE = 30 * 60;
		const collisionProfiles = {
			current: "harbor",
			harbor: {
				warning: { cpa: 0.5, tcpa: 600, speed: 0.5 },
				danger: { cpa: 0.1, tcpa: 300, speed: 3 },
				guard: { range: 0.5, speed: 0 }, // 0.5nm guard zone
			},
		};

		function createTarget(overrides = {}) {
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

		it("should trigger guard alarm when vessel is within guard range", () => {
			const targets = new Map();
			const selfTarget = createTarget({ mmsi: "000000001" });
			const otherTarget = createTarget({
				mmsi: "123456789",
				latitude: 39.005, // ~0.3nm north (within 0.5nm guard range)
				longitude: -75.0,
			});

			targets.set("000000001", selfTarget);
			targets.set("123456789", otherTarget);

			updateDerivedData(targets, selfTarget, collisionProfiles, TARGET_MAX_AGE);

			expect(otherTarget.guardAlarm).toBe(true);
			expect(otherTarget.alarmState).toBe("danger");
			expect(otherTarget.alarmType).toContain("guard");
		});

		it("should not trigger guard alarm when vessel is outside guard range", () => {
			const targets = new Map();
			const selfTarget = createTarget({ mmsi: "000000001" });
			const otherTarget = createTarget({
				mmsi: "123456789",
				latitude: 39.02, // ~1.2nm north (outside 0.5nm guard range)
				longitude: -75.0,
			});

			targets.set("000000001", selfTarget);
			targets.set("123456789", otherTarget);

			updateDerivedData(targets, selfTarget, collisionProfiles, TARGET_MAX_AGE);

			expect(otherTarget.guardAlarm).toBe(false);
		});

		it("should trigger SART alarm for SART MMSI", () => {
			const targets = new Map();
			const selfTarget = createTarget({ mmsi: "000000001" });
			const sartTarget = createTarget({
				mmsi: "970123456", // SART MMSI prefix
				latitude: 39.01,
				longitude: -75.0,
			});

			targets.set("000000001", selfTarget);
			targets.set("970123456", sartTarget);

			updateDerivedData(targets, selfTarget, collisionProfiles, TARGET_MAX_AGE);

			expect(sartTarget.sartAlarm).toBe(true);
			expect(sartTarget.alarmState).toBe("danger");
			expect(sartTarget.alarmType).toContain("sart");
		});

		it("should trigger MOB alarm for MOB MMSI", () => {
			const targets = new Map();
			const selfTarget = createTarget({ mmsi: "000000001" });
			const mobTarget = createTarget({
				mmsi: "972123456", // MOB MMSI prefix
				latitude: 39.01,
				longitude: -75.0,
			});

			targets.set("000000001", selfTarget);
			targets.set("972123456", mobTarget);

			updateDerivedData(targets, selfTarget, collisionProfiles, TARGET_MAX_AGE);

			expect(mobTarget.mobAlarm).toBe(true);
			expect(mobTarget.alarmState).toBe("danger");
			expect(mobTarget.alarmType).toContain("mob");
		});

		it("should trigger EPIRB alarm for EPIRB MMSI", () => {
			const targets = new Map();
			const selfTarget = createTarget({ mmsi: "000000001" });
			const epirbTarget = createTarget({
				mmsi: "974123456", // EPIRB MMSI prefix
				latitude: 39.01,
				longitude: -75.0,
			});

			targets.set("000000001", selfTarget);
			targets.set("974123456", epirbTarget);

			updateDerivedData(targets, selfTarget, collisionProfiles, TARGET_MAX_AGE);

			expect(epirbTarget.epirbAlarm).toBe(true);
			expect(epirbTarget.alarmState).toBe("danger");
			expect(epirbTarget.alarmType).toContain("epirb");
		});

		it("should calculate order/priority with alarm targets at top", () => {
			const targets = new Map();
			const selfTarget = createTarget({ mmsi: "000000001" });

			const alarmTarget = createTarget({
				mmsi: "123456789",
				latitude: 39.005, // within guard range
				longitude: -75.0,
			});

			const normalTarget = createTarget({
				mmsi: "987654321",
				latitude: 39.05, // outside guard range
				longitude: -75.0,
			});

			targets.set("000000001", selfTarget);
			targets.set("123456789", alarmTarget);
			targets.set("987654321", normalTarget);

			updateDerivedData(targets, selfTarget, collisionProfiles, TARGET_MAX_AGE);

			// Alarm target should have lower order (higher priority)
			expect(alarmTarget.order).toBeLessThan(normalTarget.order);
		});
	});

	describe("Formatting functions", () => {
		const TARGET_MAX_AGE = 30 * 60;
		const collisionProfiles = {
			current: "harbor",
			harbor: {
				warning: { cpa: 0.5, tcpa: 600, speed: 0.5 },
				danger: { cpa: 0.1, tcpa: 300, speed: 3 },
				guard: { range: 0, speed: 0 },
			},
		};

		function createTarget(overrides = {}) {
			return {
				mmsi: "123456789",
				latitude: 39.0,
				longitude: -75.0,
				sog: 2.57, // ~5 knots
				cog: toRadians(45),
				hdg: toRadians(45),
				lastSeenDate: new Date(),
				...overrides,
			};
		}

		it("should format SOG correctly", () => {
			const targets = new Map();
			const selfTarget = createTarget({ mmsi: "000000001" });
			const otherTarget = createTarget({ mmsi: "123456789" });

			targets.set("000000001", selfTarget);
			targets.set("123456789", otherTarget);

			updateDerivedData(targets, selfTarget, collisionProfiles, TARGET_MAX_AGE);

			expect(otherTarget.sogFormatted).toContain("kn");
			expect(otherTarget.sogFormatted).toContain("5.0"); // ~5 knots
		});

		it("should format COG correctly", () => {
			const targets = new Map();
			const selfTarget = createTarget({ mmsi: "000000001" });
			const otherTarget = createTarget({ mmsi: "123456789" });

			targets.set("000000001", selfTarget);
			targets.set("123456789", otherTarget);

			updateDerivedData(targets, selfTarget, collisionProfiles, TARGET_MAX_AGE);

			expect(otherTarget.cogFormatted).toContain("T");
			expect(otherTarget.cogFormatted).toContain("45"); // 45 degrees
		});

		it("should format range correctly", () => {
			const targets = new Map();
			const selfTarget = createTarget({ mmsi: "000000001" });
			const otherTarget = createTarget({
				mmsi: "123456789",
				latitude: 39.1, // ~6nm north
				longitude: -75.0,
			});

			targets.set("000000001", selfTarget);
			targets.set("123456789", otherTarget);

			updateDerivedData(targets, selfTarget, collisionProfiles, TARGET_MAX_AGE);

			expect(otherTarget.rangeFormatted).toContain("NM");
		});

		it("should format latitude correctly", () => {
			const targets = new Map();
			const selfTarget = createTarget({ mmsi: "000000001", latitude: 39.95 });

			targets.set("000000001", selfTarget);

			updateDerivedData(targets, selfTarget, collisionProfiles, TARGET_MAX_AGE);

			expect(selfTarget.latitudeFormatted).toMatch(/N.*39°/);
		});

		it("should format longitude correctly", () => {
			const targets = new Map();
			const selfTarget = createTarget({ mmsi: "000000001", longitude: -75.1 });

			targets.set("000000001", selfTarget);

			updateDerivedData(targets, selfTarget, collisionProfiles, TARGET_MAX_AGE);

			expect(selfTarget.longitudeFormatted).toMatch(/W.*075°/);
		});
	});
});
