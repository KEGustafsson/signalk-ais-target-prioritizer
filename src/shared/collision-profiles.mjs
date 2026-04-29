export const VALID_PROFILE_NAMES = ["anchor", "harbor", "coastal", "offshore"];

const PROFILE_SECTIONS = {
	warning: ["cpa", "tcpa", "speed"],
	danger: ["cpa", "tcpa", "speed"],
	guard: ["range", "speed"],
};

function isNonNegativeFiniteNumber(value) {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function isValidProfileShape(profile) {
	if (profile == null || typeof profile !== "object") return false;

	return Object.entries(PROFILE_SECTIONS).every(([sectionName, fieldNames]) => {
		const section = profile[sectionName];
		return (
			section != null &&
			typeof section === "object" &&
			fieldNames.every((fieldName) =>
				isNonNegativeFiniteNumber(section[fieldName]),
			)
		);
	});
}

export function isValidCollisionProfiles(collisionProfiles) {
	return (
		collisionProfiles != null &&
		typeof collisionProfiles === "object" &&
		VALID_PROFILE_NAMES.includes(collisionProfiles.current) &&
		VALID_PROFILE_NAMES.every((profileName) =>
			isValidProfileShape(collisionProfiles[profileName]),
		)
	);
}

export function cloneCollisionProfiles(collisionProfiles) {
	if (!isValidCollisionProfiles(collisionProfiles)) {
		throw new Error("Invalid collision profiles");
	}

	const cloned = { current: collisionProfiles.current };
	for (const profileName of VALID_PROFILE_NAMES) {
		cloned[profileName] = {};
		for (const [sectionName, fieldNames] of Object.entries(PROFILE_SECTIONS)) {
			cloned[profileName][sectionName] = {};
			for (const fieldName of fieldNames) {
				cloned[profileName][sectionName][fieldName] =
					collisionProfiles[profileName][sectionName][fieldName];
			}
		}
	}
	return cloned;
}
