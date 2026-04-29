import { describe, expect, it } from "vitest";
import {
	cloneCollisionProfiles,
	isValidCollisionProfiles,
} from "../../../shared/collision-profiles.mjs";

const validProfiles = {
	current: "harbor",
	anchor: {
		warning: { cpa: 0, tcpa: 3600, speed: 0 },
		danger: { cpa: 0, tcpa: 3600, speed: 0 },
		guard: { range: 0, speed: 0 },
	},
	harbor: {
		warning: { cpa: 0.5, tcpa: 600, speed: 0.5 },
		danger: { cpa: 0.1, tcpa: 300, speed: 3 },
		guard: { range: 0, speed: 0 },
	},
	coastal: {
		warning: { cpa: 2, tcpa: 1800, speed: 0 },
		danger: { cpa: 1, tcpa: 600, speed: 0.5 },
		guard: { range: 0, speed: 0 },
	},
	offshore: {
		warning: { cpa: 4, tcpa: 1800, speed: 0 },
		danger: { cpa: 2, tcpa: 900, speed: 0 },
		guard: { range: 0, speed: 0 },
	},
};

describe("collision profile validation", () => {
	it("accepts the expected collision profile shape", () => {
		expect(isValidCollisionProfiles(validProfiles)).toBe(true);
	});

	it("rejects negative and non-finite values", () => {
		const invalidProfiles = structuredClone(validProfiles);
		invalidProfiles.harbor.warning.cpa = -1;

		expect(isValidCollisionProfiles(invalidProfiles)).toBe(false);
	});

	it("rejects unknown current profiles", () => {
		const invalidProfiles = structuredClone(validProfiles);
		invalidProfiles.current = "custom";

		expect(isValidCollisionProfiles(invalidProfiles)).toBe(false);
	});

	it("clones only supported profile fields", () => {
		const profilesWithExtraFields = structuredClone(validProfiles);
		profilesWithExtraFields.harbor.threat = { cpa: 5 };
		profilesWithExtraFields.unused = { value: true };

		const cloned = cloneCollisionProfiles(profilesWithExtraFields);

		expect(cloned).not.toHaveProperty("unused");
		expect(cloned.harbor).not.toHaveProperty("threat");
		expect(cloned).toEqual(validProfiles);
	});
});
