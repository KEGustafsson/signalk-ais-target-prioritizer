export const AIS_TARGET_SUBSCRIPTION_PATHS = [
	"",
	"navigation.position",
	"navigation.courseOverGroundTrue",
	"navigation.speedOverGround",
	"navigation.magneticVariation",
	"navigation.headingTrue",
	"navigation.state",
	"navigation.destination.commonName",
	"navigation.rateOfTurn",
	"design.*",
	"sensors.ais.class",
	"atonType",
	"offPosition",
	"virtual",
];

export function buildAisTargetSubscription(period = 1000) {
	return {
		context: "*",
		subscribe: AIS_TARGET_SUBSCRIPTION_PATHS.map((path) => ({ path, period })),
	};
}
