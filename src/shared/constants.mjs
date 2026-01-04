/**
 * Shared constants used across plugin and web UI.
 * Single source of truth for configuration values.
 */

// Unit conversions
export const METERS_PER_NM = 1852;
export const KNOTS_PER_M_PER_S = 1.94384;

// Target age thresholds (in seconds)
export const TARGET_MAX_AGE = 30 * 60; // 30 minutes - targets older than this are removed
export const LOST_TARGET_WARNING_AGE = 10 * 60; // 10 minutes - targets older than this show "lost" indicator
export const GPS_STALE_WARNING_SECONDS = 30; // Warn if no GPS position for this long

// CPA/TCPA calculation limits
export const TCPA_MAX_SECONDS = 3 * 3600; // Maximum TCPA to calculate (3 hours)

// Priority order base values (lower = higher priority)
export const PRIORITY_ORDER = {
	DANGER: 10000,
	WARNING: 20000,
	CLOSING: 30000,
	DIVERGING: 40000,
	NO_RANGE: 50000,
};

// Priority order weights for fine-tuning
export const PRIORITY_WEIGHTS = {
	HAS_TCPA_BONUS: 1000, // Bonus for having any TCPA
	TCPA_WEIGHT: 1000, // Max reduction based on TCPA (shorter = higher priority)
	CPA_WEIGHT: 2000, // Max reduction based on CPA (closer = higher priority)
	RANGE_WEIGHT_PER_NM: 100, // Increase per nautical mile of range
	RANGE_WEIGHT_MAX: 5000, // Maximum range-based increase
	ORDER_MIN: -99999, // Minimum order value
	ORDER_MAX: 99999, // Maximum order value
};

// UI intervals
export const SHOW_ALARMS_INTERVAL = 60 * 1000; // Show alarms every 60 seconds
export const COURSE_PROJECTION_MINUTES = 10; // How far ahead to project vessel course

// Map defaults
export const DEFAULT_MAP_ZOOM = 14; // Gives us 2+ NM view

// WebSocket reconnection
export const WS_RECONNECT_BASE_DELAY = 1000; // Start with 1 second
export const WS_RECONNECT_MAX_DELAY = 30000; // Max 30 seconds

// Plugin identification
export const PLUGIN_ID = "signalk-ais-target-prioritizer";

// localStorage keys (namespaced to avoid conflicts)
export const STORAGE_KEYS = {
	BASE_LAYER: "ais-prioritizer-baselayer",
	OVERLAY: "ais-prioritizer-overlay",
	NO_SLEEP: "ais-prioritizer-noSleep",
	DARK_MODE: "ais-prioritizer-darkMode",
};

// SignalK data change thresholds (for optimizing publish frequency)
export const PUBLISH_THRESHOLDS = {
	CPA_METERS: 10, // Publish if CPA changed by more than 10 meters
	TCPA_SECONDS: 5, // Publish if TCPA changed by more than 5 seconds
	RANGE_METERS: 10, // Publish if range changed by more than 10 meters
	BEARING_DEGREES: 1, // Publish if bearing changed by more than 1 degree
};
