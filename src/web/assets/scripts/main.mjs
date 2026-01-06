import {
	DEFAULT_MAP_ZOOM,
	METERS_PER_NM,
	COURSE_PROJECTION_MINUTES,
	TARGET_MAX_AGE,
	GPS_STALE_WARNING_SECONDS,
	SHOW_ALARMS_INTERVAL,
	PLUGIN_ID,
	WS_RECONNECT_BASE_DELAY,
	WS_RECONNECT_MAX_DELAY,
	STORAGE_KEYS,
} from "../../../shared/constants.mjs";

const AGE_OUT_OLD_TARGETS = true;
const USE_WEBSOCKET_STREAMING = true; // Use WebSocket streaming instead of polling

import * as bootstrap from "bootstrap";
import * as labelgun from "labelgun";
import * as L from "leaflet";
import * as protomapsL from "protomaps-leaflet";
import "leaflet-easybutton";
import * as basemaps from "@protomaps/basemaps";
import NoSleep from "nosleep.js";
import defaultCollisionProfiles from "../defaultCollisionProfiles.json";
import hornMp3Url from "../horn.mp3";
import pmtilesUrl from "../ne_10m_land.pmtiles?url&no-inline";
import * as aisIons from "./ais-icons.mjs";
import {
	processDelta,
	toDegrees,
	toRadians,
	updateDerivedData,
} from "./ais-utils.mjs";
import * as targetSvgs from "./ship-icons.mjs";

const noSleep = new NoSleep();
let collisionProfiles;
let selfMmsi;
let selfTarget;
let offsetLatitude = 0;
let offsetLongitude = 0;
let disableMoveend = false;
let disableMapPanTo = false;
const targets = new Map();
let pluginTargets;
const boatMarkers = new Map();
const boatProjectedCourseLines = new Map();
const rangeRings = L.layerGroup();
let selectedVesselMmsi;
let blueBoxIcon;
let blueCircle1;
let blueCircle2;
let validTargetCount;
let filteredTargetCount;
let alarmTargetCount;
let lastAlarmTime;
let tooltipList = [];
let sortTableBy = "priority";
let signalkWebSocket = null;
let wsReconnectAttempts = 0;

const blueLayerGroup = L.layerGroup();

const bsModalAlert = new bootstrap.Modal("#modalAlert");
const bsModalAlarm = new bootstrap.Modal("#modalAlarm");
const bsModalClosebyBoats = new bootstrap.Modal("#modalClosebyBoats");
const bsModalSelectedVesselProperties = new bootstrap.Modal(
	"#modalSelectedVesselProperties",
);
const bsOffcanvasSettings = new bootstrap.Offcanvas("#offcanvasSettings");
const bsOffcanvasEditProfiles = new bootstrap.Offcanvas(
	"#offcanvasEditProfiles",
);
const bsOffcanvasTargetList = new bootstrap.Offcanvas("#offcanvasTargetList");

// load collisionProfiles
// /plugins/${PLUGIN_ID}/getCollisionProfiles
collisionProfiles = await getHttpResponse(
	`/plugins/${PLUGIN_ID}/getCollisionProfiles`,
	{ throwErrors: true },
);

// console.log("collisionProfiles", collisionProfiles);
if (!collisionProfiles.current) {
	console.log("using default collisionProfiles");
	collisionProfiles = structuredClone(defaultCollisionProfiles);
	saveCollisionProfiles();
}

document.getElementById("selectActiveProfile").value =
	collisionProfiles.current;
document.getElementById("checkNoSleep").checked =
	localStorage.getItem(STORAGE_KEYS.NO_SLEEP) === "true";
document.getElementById("checkDarkMode").checked =
	localStorage.getItem(STORAGE_KEYS.DARK_MODE) === "true";
document.getElementById("checkDebugStream").checked =
	localStorage.getItem(STORAGE_KEYS.DEBUG_STREAM) === "true";
configureNoSleep();
applyColorMode();

const charts = await getHttpResponse("/signalk/v1/api/resources/charts", {
	throwErrors: false,
	ignore404: true,
	ignoreEmptyResponse: true,
});

const data = await getHttpResponse("/signalk/v1/api/vessels/self", {
	throwErrors: true,
});
selfMmsi = data.mmsi;

pluginTargets = await getHttpResponse(`/plugins/${PLUGIN_ID}/getTargets`);

const map = L.map("map", {
	zoom: DEFAULT_MAP_ZOOM,
	minZoom: 9,
	maxZoom: 18,
});

L.easyButton("bi bi-cursor-fill", (_btn, map) => {
	if (selfTarget.isValid) {
		map.panTo([selfTarget.latitude, selfTarget.longitude]);
		offsetLatitude = 0;
		offsetLongitude = 0;
	}
}).addTo(map);

// protomaps color flavors: light dark white grayscale black
// make water transparent so that bootstrap light/dark mode backgroud comes through
const paintRules = protomapsL.paintRules({
	...basemaps.namedFlavor("light"),
	water: "rgba(0,0,0,0)",
});
const labelRules = protomapsL.labelRules(basemaps.namedFlavor("light"));

const osm = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
	maxZoom: 19,
	attribution: "© OpenStreetMap",
});

const openTopoMap = L.tileLayer(
	"https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png",
	{
		maxZoom: 19,
		attribution:
			"Map data: © OpenStreetMap contributors, SRTM | Map style: © OpenTopoMap (CC-BY-SA)",
	},
);

const satLayer = L.tileLayer(
	"https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
	{
		maxNativeZoom: 17,
		maxZoom: 20,
		attribution: "© Esri © OpenStreetMap Contributors",
	},
);

const naturalEarth10m = protomapsL.leafletLayer({
	url: pmtilesUrl,
	maxDataZoom: 5,
	paintRules: paintRules,
	labelRules: labelRules,
});

const baseMaps = {
	Empty: L.tileLayer(""),
	OpenStreetMap: osm,
	OpenTopoMap: openTopoMap,
	Satellite: satLayer,
	"NaturalEarth (offline)": naturalEarth10m,
};

let chart;
let layer;
for (const key in charts) {
	chart = charts[key];
	if (chart.format === "mvt") {
		layer = protomapsL.leafletLayer({
			url: chart.tilemapUrl,
			maxDataZoom: chart.maxzoom,
			paintRules: paintRules,
			labelRules: labelRules,
		});
	} else {
		layer = L.tileLayer(chart.tilemapUrl, {
			maxZoom: chart.maxzoom,
			attribution: "",
		});
	}
	baseMaps[chart.name] = layer;
}

const OpenSeaMap = L.tileLayer(
	"https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png",
	{
		maxZoom: 19,
		attribution: "",
	},
);

const overlayMaps = {
	OpenSeaMap: OpenSeaMap,
};

L.control.layers(baseMaps, overlayMaps, { position: "topleft" }).addTo(map);

const layerControlLayersToggleEl = document.getElementsByClassName(
	"leaflet-control-layers-toggle",
)[0];

layerControlLayersToggleEl.classList.add("bi", "bi-layers-fill");

L.easyButton("bi bi-list-ul", () => {
	bsOffcanvasTargetList.show();
}).addTo(map);

L.easyButton("bi bi-gear-fill", () => {
	bsOffcanvasSettings.show();
}).addTo(map);

// reload last used baselayer/overlay
let baselayer = localStorage.getItem(STORAGE_KEYS.BASE_LAYER);
const overlay = localStorage.getItem(STORAGE_KEYS.OVERLAY);
if (!baseMaps[baselayer]) {
	baselayer = "OpenStreetMap";
}
baseMaps[baselayer].addTo(map);
if (overlay && overlayMaps[overlay]) {
	overlayMaps[overlay].addTo(map);
}

blueBoxIcon = L.marker([], {
	icon: aisIons.getBlueBoxIcon(),
});

blueCircle1 = L.circleMarker([], {
	radius: 6,
	color: "blue",
	opacity: 1.0,
	fillOpacity: 1.0,
	interactive: false,
	className: "blueStuff",
});

blueCircle2 = L.circleMarker([], {
	radius: 6,
	color: "blue",
	opacity: 1.0,
	fillOpacity: 1.0,
	interactive: false,
	className: "blueStuff",
});

// we're adding all the blue stuff to a layer group so that we can raise the z index of the whole group
// and turn visibility on/off in one shot
blueLayerGroup.addLayer(blueBoxIcon);
blueLayerGroup.addLayer(blueCircle1);
blueLayerGroup.addLayer(blueCircle2);

// setup vessel label collision avoidance
const hideLabel = (label) => {
	label.labelObject.style.opacity = 0;
};
const showLabel = (label) => {
	label.labelObject.style.opacity = 1;
};
const labelToCollisionController = new labelgun.default(hideLabel, showLabel);

const alertPlaceholder = document.getElementById("alertPlaceholder");

// *********************************************************************************************************
// ** REGISTER EVENT LISTENERS

map.on("baselayerchange", handleBaseLayerChange);
map.on("overlayadd", handleOverlayAdd);
map.on("overlayremove", handleOverlayRemove);

document
	.getElementById("tableOfTargetsBody")
	.addEventListener("click", handleTableOfTargetsBodyClick);

document
	.getElementById("listOfClosebyBoats")
	.addEventListener("click", handleListOfClosebyBoatsClick);

document
	.getElementById("selectActiveProfile")
	.addEventListener("input", (ev) => {
		collisionProfiles.current = ev.target.value;
		saveCollisionProfiles();
	});

document.getElementById("selectTableSort").addEventListener("input", (ev) => {
	sortTableBy = ev.target.value;
});

document.getElementById("buttonEditProfiles").addEventListener("click", () => {
	bsOffcanvasSettings.hide();
	selectProfileToEdit.value = selectActiveProfile.value;
	setupProfileEditView(selectProfileToEdit.value);
	bsOffcanvasEditProfiles.show();
});

document.getElementById("checkNoSleep").addEventListener("change", () => {
	configureNoSleep();
});

document
	.getElementById("checkDarkMode")
	.addEventListener("change", applyColorMode);

document.getElementById("checkFullScreen").addEventListener("change", () => {
	if (checkFullScreen.checked) {
		if (!document.fullscreenElement) {
			document.documentElement.requestFullscreen();
		} else if (!document.webkitFullscreenElement) {
			document.documentElement.webkitRequestFullscreen();
		}
	} else {
		if (document.exitFullscreen) {
			document.exitFullscreen();
		} else if (document.webkitExitFullscreen) {
			document.webkitExitFullscreen();
		}
	}
});

document.addEventListener("fullscreenchange", fullscreenchangeHandler);

//document.addEventListener("webkitfullscreenchange", fullscreenchangeHandler);

document.getElementById("checkDebugStream").addEventListener("change", () => {
	localStorage.setItem(STORAGE_KEYS.DEBUG_STREAM, checkDebugStream.checked);
	if (!checkDebugStream.checked) {
		map.attributionControl.setPrefix(false);
	}
});

document
	.getElementById("selectProfileToEdit")
	.addEventListener("input", (ev) => {
		setupProfileEditView(ev.target.value);
	});

document
	.getElementById("buttonRestoreDefaults")
	.addEventListener("click", () => {
		collisionProfiles = structuredClone(defaultCollisionProfiles);
		setupProfileEditView(selectProfileToEdit.value);
		saveCollisionProfiles();
	});

document
	.getElementById("buttonMuteAllAlarms")
	.addEventListener("click", muteAllAlarms);
document
	.getElementById("buttonMuteAllAlarms2")
	.addEventListener("click", muteAllAlarms);

document
	.getElementById("buttonMuteToggle")
	.addEventListener("click", handleButtonMuteToggle);

// save config when offcanvasEditProfiles is closed
offcanvasEditProfiles.addEventListener("hide.bs.offcanvas", () => {
	saveCollisionProfiles();
});

// show modalSelectedVesselProperties when modalClosebyBoats is closed
modalClosebyBoats.addEventListener("hidden.bs.modal", () => {
	const boatMarker = boatMarkers.get(selectedVesselMmsi);
	positionModalWindow(boatMarker.getLatLng(), "modalSelectedVesselProperties");
	showModalSelectVesselProperties(targets.get(selectedVesselMmsi));
});

configWarningCpaRange.addEventListener("input", processDistanceRangeControl);
configWarningTcpaRange.addEventListener("input", processTcpaRangeControl);
configWarningSogRange.addEventListener("input", processSpeedRangeControl);

configAlarmCpaRange.addEventListener("input", processDistanceRangeControl);
configAlarmTcpaRange.addEventListener("input", processTcpaRangeControl);
configAlarmSogRange.addEventListener("input", processSpeedRangeControl);

configGuardRangeRange.addEventListener("input", processDistanceRangeControl);
configGuardSogRange.addEventListener("input", processSpeedRangeControl);

map.on("movestart", () => {
	disableMapPanTo = true;
});

map.on("moveend", () => {
	disableMapPanTo = false;

	if (disableMoveend) {
		return;
	}

	// if the map was panned, store the offsets from selfTarget
	if (selfTarget.isValid) {
		const mapCenter = map.getCenter();
		offsetLatitude = mapCenter.lat - selfTarget.latitude;
		offsetLongitude = mapCenter.lng - selfTarget.longitude;
	}
});

map.on("zoomend", () => {
	drawRangeRings();
	labelToCollisionController.update();
});

map.on("click", handleMapClick);

// ** END REGISTER EVENT LISTENERS
// *********************************************************************************************************

function fullscreenchangeHandler() {
	if (document.fullscreenElement) {
		checkFullScreen.checked = true;
	} else {
		checkFullScreen.checked = false;
	}
}

function applyColorMode() {
	localStorage.setItem(STORAGE_KEYS.DARK_MODE, checkDarkMode.checked);
	if (checkDarkMode.checked) {
		// dark mode
		document.documentElement.setAttribute("data-bs-theme", "dark");
		const elements = document.querySelectorAll(".leaflet-layer");
		for (let i = 0; i < elements.length; i++) {
			elements[i].style.filter =
				"invert(1) hue-rotate(180deg) brightness(0.8) contrast(1.2)";
		}
	} else {
		// light mode
		document.documentElement.setAttribute("data-bs-theme", "light");
		const elements = document.querySelectorAll(".leaflet-layer");
		for (let i = 0; i < elements.length; i++) {
			elements[i].style.filter = "none";
		}
	}
}

function configureNoSleep() {
	if (checkNoSleep.checked) {
		noSleep.enable();
	} else {
		noSleep.disable();
	}
	localStorage.setItem(STORAGE_KEYS.NO_SLEEP, checkNoSleep.checked);
}

function handleBaseLayerChange(event) {
	localStorage.setItem(STORAGE_KEYS.BASE_LAYER, event.name);
	applyColorMode();
}

function handleOverlayAdd(event) {
	localStorage.setItem(STORAGE_KEYS.OVERLAY, event.name);
	applyColorMode();
}

function handleOverlayRemove() {
	localStorage.removeItem(STORAGE_KEYS.OVERLAY);
}

// initialize profile edit screen on startup
setupProfileEditView("anchor");

// Initial data load via HTTP
await initialDataLoad();

// Start streaming or polling based on configuration
if (USE_WEBSOCKET_STREAMING) {
	connectToSignalKStream();
	// Still run UI updates on interval, but don't fetch data
	setInterval(updateLoop, 1000);
} else {
	// Fall back to polling
	setInterval(refresh, 1000);
}

function setupProfileEditView(profile) {
	configWarningCpaRange.value = distanceToTick(
		collisionProfiles[profile].warning.cpa,
	);
	configWarningTcpaRange.value = timeToTick(
		collisionProfiles[profile].warning.tcpa / 60,
	);
	configWarningSogRange.value = speedToTick(
		collisionProfiles[profile].warning.speed,
	);

	configAlarmCpaRange.value = distanceToTick(
		collisionProfiles[profile].danger.cpa,
	);
	configAlarmTcpaRange.value = timeToTick(
		collisionProfiles[profile].danger.tcpa / 60,
	);
	configAlarmSogRange.value = speedToTick(
		collisionProfiles[profile].danger.speed,
	);

	configGuardRangeRange.value = distanceToTick(
		collisionProfiles[profile].guard.range,
	);
	configGuardSogRange.value = speedToTick(
		collisionProfiles[profile].guard.speed,
	);

	const inputEvent = new Event("input");

	configWarningCpaRange.dispatchEvent(inputEvent);
	configWarningTcpaRange.dispatchEvent(inputEvent);
	configWarningSogRange.dispatchEvent(inputEvent);

	configAlarmCpaRange.dispatchEvent(inputEvent);
	configAlarmTcpaRange.dispatchEvent(inputEvent);
	configAlarmSogRange.dispatchEvent(inputEvent);

	configGuardRangeRange.dispatchEvent(inputEvent);
	configGuardSogRange.dispatchEvent(inputEvent);
}

/** Timer for debouncing collision profile saves */
let saveCollisionProfilesTimer = null;
const SAVE_DEBOUNCE_MS = 500;

/**
 * Saves collision profiles to the server with debouncing.
 * Multiple rapid calls will be coalesced into a single save.
 */
function saveCollisionProfiles() {
	// Clear any existing timer
	if (saveCollisionProfilesTimer) {
		clearTimeout(saveCollisionProfilesTimer);
	}

	// Set new timer to save after debounce period
	saveCollisionProfilesTimer = setTimeout(async () => {
		console.log("*** save collisionProfiles to server", collisionProfiles);

		try {
			const response = await fetch(
				`/plugins/${PLUGIN_ID}/setCollisionProfiles`,
				{
					credentials: "include",
					method: "PUT",
					body: JSON.stringify(collisionProfiles),
					headers: {
						"Content-Type": "application/json",
					},
				},
			);
			if (response.status === 401) {
				location.href = "/admin/#/login";
			}
			if (!response.ok) {
				throw new Error(
					`Error saving collisionProfiles. Response status: ${response.status} from ${response.url}`,
				);
			}
			console.log("successfully saved config", collisionProfiles);
		} catch (error) {
			console.error("Error saving collision profiles:", error);
			showError(`Error saving settings: ${error.message}`);
		}
	}, SAVE_DEBOUNCE_MS);
}

function showError(message) {
	document.getElementById("errorMessage").textContent = message;
	bsModalAlert.show();
}

function handleTableOfTargetsBodyClick(ev) {
	bsOffcanvasTargetList.hide();
	const tr = ev.target.closest("tr");
	const mmsi = tr.dataset.mmsi;
	const boatMarker = boatMarkers.get(mmsi);
	selectBoatMarker(boatMarker);
	// Note: Could potentially use blueLayerGroup with L.featureGroup for better layer management
	map.fitBounds([
		boatMarker.getLatLng(),
		boatMarkers.get(selfMmsi).getLatLng(),
	]);
	positionModalWindow(boatMarker.getLatLng(), "modalSelectedVesselProperties");
	showModalSelectVesselProperties(targets.get(boatMarker.mmsi));
}

function distanceToTick(distance) {
	return distance <= 1 ? Math.floor(distance * 10) : Math.floor(distance + 9);
}

function tickToDistance(tick) {
	return tick <= 10 ? tick / 10 : tick - 9;
}

function processDistanceRangeControl(ev) {
	const tick = ev.target.value;
	const dataset = ev.target.dataset;
	const valueStorageElement = document.getElementById(dataset.target);
	// 0,0.1,0.2 ... 1.0,2,3,4,5,6,7,8,9,10
	// 20 values
	// tick                     distance
	// 0 - 10   correspond to   0 - 1.0
	// 11 - 19  correspond to   2 - 10
	const distance = tickToDistance(tick);
	const unitsSpan = document.getElementById(`${dataset.target}Units`);

	if (distance === 0) {
		unitsSpan.hidden = true;
	} else {
		unitsSpan.hidden = false;
	}

	valueStorageElement.textContent = distance || "OFF";
	collisionProfiles[selectProfileToEdit.value][dataset.alarmType][
		dataset.alarmCriteria
	] = distance;
}

function timeToTick(time) {
	if (time <= 5) {
		return Math.floor(time);
	} else if (time <= 20) {
		return Math.floor((time - 10) / 5 + 6);
	} else {
		return Math.floor((time - 30) / 10 + 9);
	}
}

function tickToTime(tick) {
	if (tick <= 5) {
		return tick;
	} else if (tick <= 8) {
		return (tick - 6) * 5 + 10;
	} else {
		return (tick - 9) * 10 + 30;
	}
}

function processTcpaRangeControl(ev) {
	const tick = ev.target.value;
	const dataset = ev.target.dataset;
	const valueStorageElement = document.getElementById(dataset.target);
	// 1,2,3,4,  5,  10,15,  20,  30,40,50,60
	// 12 values
	// tick                     time (min)
	// 1 - 5    correspond to   1 - 5
	// 6 - 8    correspond to   10 - 20
	// 9 - 12   correspond to   30 - 60
	const time = tickToTime(tick);
	valueStorageElement.textContent = time;
	collisionProfiles[selectProfileToEdit.value][dataset.alarmType][
		dataset.alarmCriteria
	] = time * 60;
}

function speedToTick(speed) {
	if (speed <= 0.5) {
		return Math.floor(speed * 10);
	} else if (speed <= 3) {
		return Math.floor(speed + 5);
	} else {
		return Math.floor(speed / 5 + 8);
	}
}

function tickToSpeed(tick) {
	if (tick <= 5) {
		return tick / 10;
	} else if (tick <= 8) {
		return tick - 5;
	} else {
		return (tick - 8) * 5;
	}
}

function processSpeedRangeControl(ev) {
	const tick = ev.target.value;
	const dataset = ev.target.dataset;
	const valueStorageElement = document.getElementById(dataset.target);
	// 0,0.1,0,2 ... 0.5,1,2,3,5,10
	// 11 values
	// tick                     speed (knots)
	// 0 - 5    correspond to   0.0 - 0.5
	// 6        correspond to   1
	// 7        correspond to   2
	// 8        correspond to   3
	// 9        correspond to   5
	// 10       correspond to   10
	const speed = tickToSpeed(tick);
	valueStorageElement.textContent = speed;
	collisionProfiles[selectProfileToEdit.value][dataset.alarmType][
		dataset.alarmCriteria
	] = speed;
}

function drawRangeRings() {
	if (!selfTarget.isValid) {
		return;
	}
	rangeRings.removeFrom(map);
	rangeRings.clearLayers();

	const mapHeightInNauticalMiles =
		60 * Math.abs(map.getBounds().getNorth() - map.getBounds().getSouth());

	// aiming for 3 visible range rings
	let step = mapHeightInNauticalMiles / 6;

	if (step < 0.125) {
		step = 0.125;
	} else if (step < 0.25) {
		step = 0.25;
	} else if (step < 0.5) {
		step = 0.5;
	} else if (step < 1) {
		step = 1;
	} else {
		step = 2 * Math.round(step / 2);
	}

	for (let i = 1; i <= 6; i++) {
		rangeRings.addLayer(
			L.circle([selfTarget.latitude, selfTarget.longitude], {
				radius: i * step * METERS_PER_NM,
				color: "gray",
				weight: 1,
				opacity: 0.7,
				fill: false,
				interactive: false,
				zIndexOffset: -999,
			}),
		);

		rangeRings.addLayer(
			L.tooltip([selfTarget.latitude + (i * step) / 60, selfTarget.longitude], {
				content: `${i * step} NM`,
				permanent: true,
				direction: "center",
				opacity: 0.7,
				offset: [0, 15],
				className: "map-labels",
				interactive: false,
				zIndexOffset: -999,
			}),
		);

		rangeRings.addLayer(
			L.tooltip([selfTarget.latitude - (i * step) / 60, selfTarget.longitude], {
				content: `${i * step} NM`,
				permanent: true,
				direction: "center",
				opacity: 0.7,
				offset: [0, -15],
				className: "map-labels",
				interactive: false,
				zIndexOffset: -999,
			}),
		);
	}

	rangeRings.addTo(map);
}

// Initial data load via HTTP (used once at startup)
async function initialDataLoad() {
	try {
		let vessels = await getHttpResponse("/signalk/v1/api/vessels", {
			throwErrors: true,
		});

		// we expect 404s from this when there are no atons:
		const atons = await getHttpResponse("/signalk/v1/api/atons", {
			ignore404: true,
		});
		vessels = Object.assign(vessels, atons);

		ingestRawVesselData(vessels);
		selfTarget = targets.get(selfMmsi);

		// Get mute data from plugin
		UpdateTargetsWithMuteDataFromPlugin();
	} catch (error) {
		console.error("Error in initialDataLoad:", error);
		showError(`Error loading initial data: ${error}`);
	}
}

/**
 * Updates the connection status indicator in the UI.
 * @param {"connected" | "disconnected" | "reconnecting"} status - Connection status
 * @param {string} [message] - Optional message to display
 */
function updateConnectionStatus(status, message) {
	const statusIndicator = document.getElementById("connectionStatus");
	if (!statusIndicator) return;

	statusIndicator.classList.remove(
		"text-success",
		"text-danger",
		"text-warning",
	);

	switch (status) {
		case "connected":
			statusIndicator.classList.add("text-success");
			statusIndicator.innerHTML =
				'<i class="bi bi-wifi"></i> <span class="d-none d-sm-inline">Connected</span>';
			statusIndicator.title = "Connected to SignalK";
			break;
		case "disconnected":
			statusIndicator.classList.add("text-danger");
			statusIndicator.innerHTML =
				'<i class="bi bi-wifi-off"></i> <span class="d-none d-sm-inline">Offline</span>';
			statusIndicator.title = message || "Disconnected from SignalK";
			break;
		case "reconnecting":
			statusIndicator.classList.add("text-warning");
			statusIndicator.innerHTML =
				'<i class="bi bi-arrow-repeat"></i> <span class="d-none d-sm-inline">Reconnecting...</span>';
			statusIndicator.title = message || "Attempting to reconnect...";
			break;
	}
}

// Connect to SignalK WebSocket stream for real-time updates
function connectToSignalKStream() {
	const wsProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
	const wsUrl = `${wsProtocol}//${window.location.host}/signalk/v1/stream?subscribe=none`;

	console.log("Connecting to SignalK stream:", wsUrl);
	updateConnectionStatus("reconnecting", "Connecting...");
	signalkWebSocket = new WebSocket(wsUrl);

	signalkWebSocket.onopen = () => {
		console.log("SignalK WebSocket connected");
		wsReconnectAttempts = 0; // Reset backoff on successful connection
		updateConnectionStatus("connected");

		// Subscribe to vessel and aton data
		const subscription = {
			context: "*",
			subscribe: [
				{ path: "", period: 1000 },
				{ path: "navigation.position", period: 1000 },
				{ path: "navigation.courseOverGroundTrue", period: 1000 },
				{ path: "navigation.speedOverGround", period: 1000 },
				{ path: "navigation.headingTrue", period: 1000 },
				{ path: "navigation.rateOfTurn", period: 1000 },
				{ path: "navigation.state", period: 1000 },
				{ path: "navigation.destination.commonName", period: 1000 },
				{ path: "design.*", period: 1000 },
				{ path: "sensors.ais.class", period: 1000 },
				{ path: "atonType", period: 1000 },
				{ path: "offPosition", period: 1000 },
				{ path: "virtual", period: 1000 },
			],
		};
		signalkWebSocket.send(JSON.stringify(subscription));
	};

	signalkWebSocket.onmessage = (event) => {
		try {
			const delta = JSON.parse(event.data);
			if (delta.updates) {
				handleDelta(delta);
			}
		} catch (error) {
			console.error("Error processing WebSocket message:", error);
		}
	};

	signalkWebSocket.onerror = (error) => {
		console.error("SignalK WebSocket error:", error);
		updateConnectionStatus("disconnected", "Connection error");
	};

	signalkWebSocket.onclose = () => {
		wsReconnectAttempts++;
		const delay = Math.min(
			WS_RECONNECT_BASE_DELAY * Math.pow(2, wsReconnectAttempts - 1),
			WS_RECONNECT_MAX_DELAY,
		);
		console.log(
			`SignalK WebSocket closed, reconnecting in ${delay / 1000} seconds (attempt ${wsReconnectAttempts})...`,
		);
		updateConnectionStatus(
			"reconnecting",
			`Reconnecting in ${delay / 1000}s (attempt ${wsReconnectAttempts})`,
		);
		setTimeout(connectToSignalKStream, delay);
	};
}

// Process delta messages from WebSocket stream - uses shared function from ais-utils.mjs
function handleDelta(delta) {
	processDelta(delta, targets);
}

// Update loop for streaming mode (no data fetching, just UI updates)
function updateLoop() {
	try {
		const startTime = new Date();

		validTargetCount = 0;
		filteredTargetCount = 0;
		alarmTargetCount = 0;

		selfTarget = targets.get(selfMmsi);

		try {
			updateDerivedData(targets, selfTarget, collisionProfiles, TARGET_MAX_AGE);
		} catch (error) {
			console.error(error);
			showError(`No GPS position available. Verify that you are connected to the
                SignalK server and that the SignalK server has a position for your vessel.<br><br>
                ${error}`);
			return;
		}

		updateUI();

		if (AGE_OUT_OLD_TARGETS) {
			ageOutOldTargets();
		}

		if (
			alarmTargetCount > 0 &&
			(lastAlarmTime == null ||
				Date.now() > lastAlarmTime + SHOW_ALARMS_INTERVAL)
		) {
			lastAlarmTime = Date.now();
			showAlarms();
		}

		if (selfTarget?.lastSeen > GPS_STALE_WARNING_SECONDS) {
			console.error(
				`No GPS position received for more than ${selfTarget.lastSeen} seconds`,
			);
			showError(`No GPS position received for more than ${selfTarget.lastSeen} seconds. Verify that you are connected to the
                SignalK server and that the SignalK server has a position for your vessel.`);
		}

		// display performance metrics
		if (checkDebugStream.checked) {
			const updateTimeInMillisecs = Date.now() - startTime.getTime();
			map.attributionControl.setPrefix(
				`${updateTimeInMillisecs} ms / ${targets.size} vessels incl. own (streaming)`,
			);
		}
	} catch (error) {
		console.error("Error in updateLoop:", error);
	}
}

// Legacy polling refresh (fallback when streaming is disabled)
async function refresh() {
	try {
		const startTime = new Date();

		let vessels = await getHttpResponse("/signalk/v1/api/vessels", {
			throwErrors: true,
		});

		const atons = await getHttpResponse("/signalk/v1/api/atons", {
			ignore404: true,
		});
		vessels = Object.assign(vessels, atons);

		validTargetCount = 0;
		filteredTargetCount = 0;
		alarmTargetCount = 0;

		ingestRawVesselData(vessels);

		selfTarget = targets.get(selfMmsi);

		try {
			updateDerivedData(targets, selfTarget, collisionProfiles, TARGET_MAX_AGE);
		} catch (error) {
			console.error(error);
			showError(`No GPS position available. Verify that you are connected to the
                SignalK server and that the SignalK server has a position for your vessel.<br><br>
                ${error}`);
		}

		UpdateTargetsWithMuteDataFromPlugin();

		updateUI();

		if (AGE_OUT_OLD_TARGETS) {
			ageOutOldTargets();
		}

		if (
			alarmTargetCount > 0 &&
			(lastAlarmTime == null ||
				Date.now() > lastAlarmTime + SHOW_ALARMS_INTERVAL)
		) {
			lastAlarmTime = Date.now();
			showAlarms();
		}

		if (selfTarget?.lastSeen > GPS_STALE_WARNING_SECONDS) {
			console.error(
				`No GPS position received for more than ${selfTarget.lastSeen} seconds`,
			);
			showError(`No GPS position received for more than ${selfTarget.lastSeen} seconds. Verify that you are connected to the
                SignalK server and that the SignalK server has a position for your vessel.`);
		}

		if (checkDebugStream.checked) {
			const updateTimeInMillisecs = Date.now() - startTime.getTime();
			map.attributionControl.setPrefix(
				`${updateTimeInMillisecs} ms / ${targets.size} vessels incl. own`,
			);
		}
	} catch (error) {
		console.error("Error in refresh:", error);
	}
}

function UpdateTargetsWithMuteDataFromPlugin() {
	if (!pluginTargets) {
		return;
	}
	targets.forEach((target, mmsi) => {
		const pluginTarget = pluginTargets[mmsi];

		if (pluginTarget?.alarmIsMuted) {
			console.log(
				`setting target ${mmsi} ${target.name} to muted because it is muted in the plugin`,
			);
			target.alarmIsMuted = true;
		}
	});
	pluginTargets = null;
}

function showAlarms() {
	const targetsWithAlarms = [];
	targets.forEach((target) => {
		if (target.isValid && target.alarmState && !target.alarmIsMuted) {
			targetsWithAlarms.push(target);
		}
	});

	if (targetsWithAlarms.length > 0) {
		const alarmDiv = document.getElementById("alarmDiv");
		alarmDiv.textContent = ""; // Clear safely
		targetsWithAlarms.forEach((target) => {
			let message = `${target.name} - ${target.alarmType.toUpperCase()} - `;
			if (target.alarmType.includes("cpa")) {
				message += `${target.cpaFormatted} ${target.tcpaFormatted}`;
			} else {
				message += `${target.rangeFormatted}`;
			}
			const alertDiv = document.createElement("div");
			alertDiv.className = "alert alert-danger";
			alertDiv.setAttribute("role", "alert");
			alertDiv.textContent = message;
			alarmDiv.appendChild(alertDiv);
		});
		bsModalAlarm.show();
		new Audio(hornMp3Url).play();
	}
}

async function muteAllAlarms() {
	console.log("muting all alarms");
	targets.forEach((target, mmsi) => {
		if (target.alarmState === "danger" && !target.alarmIsMuted) {
			console.log(
				"muting alarm for target",
				mmsi,
				target.name,
				target.alarmType,
				target.alarmState,
			);
			target.alarmIsMuted = true;
		}
	});

	// mute alarms in the plugin as well
	// POST /plugins/${PLUGIN_ID}/muteAllAlarms
	await fetch(`/plugins/${PLUGIN_ID}/muteAllAlarms`, {
		credentials: "include",
		method: "POST",
	});
}

async function handleButtonMuteToggle() {
	const target = targets.get(selectedVesselMmsi);
	target.alarmIsMuted = !target.alarmIsMuted;
	updateButtonMuteToggleIcon(target);
	showAlert(`Target ${target.alarmIsMuted ? "" : "un"}muted`, "success");

	console.log(
		"setting alarmIsMuted",
		target.mmsi,
		target.name,
		target.alarmIsMuted,
	);

	// PUT /plugins/${PLUGIN_ID}/setAlarmIsMuted
	await fetch(`/plugins/${PLUGIN_ID}/setAlarmIsMuted`, {
		credentials: "include",
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ mmsi: target.mmsi, alarmIsMuted: target.alarmIsMuted }),
	});
}

function updateButtonMuteToggleIcon(target) {
	if (target.alarmIsMuted) {
		document.querySelector("#buttonMuteToggle > i").className =
			"bi bi-volume-mute-fill";
	} else {
		document.querySelector("#buttonMuteToggle > i").className =
			"bi bi-volume-up-fill";
	}
}

function showAlert(message, type) {
	alertPlaceholder.textContent = ""; // Clear safely
	const alertDiv = document.createElement("div");
	alertDiv.className = `alert alert-${type} alert-dismissible`;
	alertDiv.setAttribute("role", "alert");
	const messageDiv = document.createElement("div");
	messageDiv.textContent = message;
	alertDiv.appendChild(messageDiv);
	const closeButton = document.createElement("button");
	closeButton.type = "button";
	closeButton.className = "btn-close";
	closeButton.setAttribute("data-bs-dismiss", "alert");
	closeButton.setAttribute("aria-label", "Close");
	alertDiv.appendChild(closeButton);
	alertPlaceholder.appendChild(alertDiv);
}

// get vessel data into an easier to access data model
// values in their original data types - no text formatting of numeric values here
function ingestRawVesselData(vessels) {
	for (const vesselId in vessels) {
		const vessel = vessels[vesselId];

		let target = targets.get(vessel.mmsi);
		if (!target) {
			target = {};
		}

		target.lastSeenDate = new Date(vessel.navigation?.position?.timestamp);

		const lastSeen = Math.round((Date.now() - target.lastSeenDate) / 1000);

		// dont add targets that have already aged out
		if (lastSeen >= TARGET_MAX_AGE) {
			continue;
		}

		target.mmsi = String(vessel.mmsi);
		target.name = vessel.name || `<${vessel.mmsi}>`;
		target.sog = vessel.navigation?.speedOverGround?.value;
		target.cog = vessel.navigation?.courseOverGroundTrue?.value;
		target.hdg = vessel.navigation?.headingTrue?.value;
		target.rot = vessel.navigation?.rateOfTurn?.value;
		target.callsign = vessel.communication?.callsignVhf || "---";
		target.typeId =
			vessel.design?.aisShipType?.value.id || vessel.atonType?.value.id;
		target.type =
			(vessel.design?.aisShipType?.value.name || vessel.atonType?.value.name) ??
			"---";
		target.aisClass = vessel.sensors?.ais?.class?.value || "A";
		target.isVirtual = vessel.virtual?.value;
		target.isOffPosition = vessel.offPosition?.value;
		target.status = vessel.navigation?.state?.value ?? "---";
		target.length = vessel.design?.length?.value.overall;
		target.beam = vessel.design?.beam?.value;
		target.draft = vessel.design?.draft?.current ?? "---";
		target.destination =
			vessel.navigation?.destination?.commonName?.value ?? "---";
		target.eta = vessel.navigation?.destination?.eta?.value ?? "---";
		target.imo = vessel.registrations?.imo;
		target.latitude = vessel.navigation?.position?.value.latitude;
		target.longitude = vessel.navigation?.position?.value.longitude;

		// For testing: can override GPS with SignalK team sample data (Netherlands region)
		// if (target.mmsi == selfMmsi) {
		//     target.latitude = 53.44;
		//     target.longitude = 4.86 //5.07;
		// }

		targets.set(target.mmsi, target);
	}
}

function updateSelectedVesselProperties(target) {
	updateButtonMuteToggleIcon(target);
	document.getElementById("target.name").textContent = target.name;
	document.getElementById("target.lastSeen").textContent = target.lastSeen;
	document.getElementById("target.cpaFormatted").textContent =
		target.cpaFormatted;
	document.getElementById("target.tcpaFormatted").textContent =
		target.tcpaFormatted;
	document.getElementById("target.rangeFormatted").textContent =
		target.rangeFormatted;
	document.getElementById("target.bearingFormatted").textContent =
		target.bearingFormatted;
	document.getElementById("target.sogFormatted").textContent =
		target.sogFormatted;
	document.getElementById("target.cogFormatted").textContent =
		target.cogFormatted;
	document.getElementById("target.hdgFormatted").textContent =
		target.hdgFormatted;
	document.getElementById("target.rotFormatted").textContent =
		target.rotFormatted;
	document.getElementById("target.callsign").textContent = target.callsign;
	document.getElementById("target.mmsi").textContent = target.mmsi;
	document.getElementById("target.mmsiCountryCode").textContent =
		target.mmsiCountryCode;
	document
		.getElementById("target.mmsiCountryCode")
		.setAttribute("data-bs-title", target.mmsiCountryName);
	document.getElementById("target.type").textContent = target.type;
	document.getElementById("target.aisClassFormatted").textContent =
		target.aisClassFormatted;
	document.getElementById("target.status").textContent = target.status;
	document.getElementById("target.sizeFormatted").textContent =
		target.sizeFormatted;
	document.getElementById("target.draft").textContent = target.draft;
	document.getElementById("target.destination").textContent =
		target.destination;
	document.getElementById("target.eta").textContent = target.eta;
	document.getElementById("target.imoFormatted").textContent =
		target.imoFormatted;
	document.getElementById("target.latitudeFormatted").textContent =
		target.latitudeFormatted;
	document.getElementById("target.longitudeFormatted").textContent =
		target.longitudeFormatted;
	// navigation.specialManeuver

	activateToolTips();

	const classARows = document.querySelectorAll(".ais-class-a");

	// show/hide class A fields:
	if (target.aisClass === "A") {
		[...classARows].map((row) => row.classList.remove("d-none"));
	} else {
		[...classARows].map((row) => row.classList.add("d-none"));
	}

	// show/hide alert:
	const selectedVesselAlert = document.getElementById("selectedVesselAlert");

	if (target.alarmState === "danger") {
		selectedVesselAlert.classList.remove("alert-warning");
		selectedVesselAlert.classList.add("alert-danger");
		selectedVesselAlert.textContent = `${target.alarmType} alarm`.toUpperCase();
		selectedVesselAlert.classList.remove("d-none");
	} else if (target.alarmState === "warning") {
		selectedVesselAlert.classList.remove("alert-danger");
		selectedVesselAlert.classList.add("alert-warning");
		selectedVesselAlert.textContent =
			`${target.alarmType} warning`.toUpperCase();
		selectedVesselAlert.classList.remove("d-none");
	} else {
		selectedVesselAlert.classList.add("d-none");
	}
}

function activateToolTips() {
	// Dispose old tooltips to prevent memory leaks
	tooltipList.forEach((tooltip) => {
		tooltip.dispose();
	});

	const tooltipTriggerList = document.querySelectorAll(
		'[data-bs-toggle="tooltip"]',
	);
	tooltipList = [...tooltipTriggerList].map(
		(tooltipTriggerEl) => new bootstrap.Tooltip(tooltipTriggerEl),
	);
}

function updateUI() {
	// keep map centered on selfTarget as it moves
	// accomodates offsets if the user has panned the map
	if (selfTarget.isValid) {
		// we cant pan the map in code if the user is already panning the map by mouse
		if (!disableMapPanTo) {
			try {
				disableMoveend = true;
				map.panTo(
					[
						selfTarget.latitude + offsetLatitude,
						selfTarget.longitude + offsetLongitude,
					],
					{
						animate: false,
					},
				);
			} finally {
				disableMoveend = false;
			}
		}

		// keep the range rings centered on selfTarget - even if we didnt pan (above)
		drawRangeRings();
	}

	targets.forEach((target) => {
		//console.log(target);
		updateSingleVesselUI(target);

		// update data shown in modal properties screen
		if (target.mmsi === selectedVesselMmsi) {
			updateSelectedVesselProperties(target);
		}
	});

	labelToCollisionController.update();

	updateTableOfTargets();

	// update displayed target counts
	totalTargetCountUI.textContent = validTargetCount || 0;
	filteredTargetCountUI.textContent = filteredTargetCount || 0;
	alarmTargetCountUI.textContent = alarmTargetCount || 0;
}

function updateTableOfTargets() {
	const targetsArray = Array.from(targets.values());

	targetsArray.sort((a, b) => {
		try {
			if (sortTableBy === "tcpa") {
				return a.tcpa - b.tcpa;
			} else if (sortTableBy === "cpa") {
				return a.cpa - b.cpa;
			} else if (sortTableBy === "range") {
				return a.range - b.range;
			} else if (sortTableBy === "name") {
				return a.name > b.name ? 1 : -1;
			} else {
				return a.order - b.order;
			}
		} catch (error) {
			console.error(error);
			return 0;
		}
	});

	const fragment = document.createDocumentFragment();
	let rowCount = 0;

	for (const target of targetsArray) {
		if (target.mmsi !== selfMmsi && target.isValid) {
			const tr = document.createElement("tr");
			if (target.alarmState === "danger") {
				tr.className = "table-danger";
			} else if (target.alarmState === "warning") {
				tr.className = "table-warning";
			}
			tr.dataset.mmsi = target.mmsi;

			// Icon cell
			const iconTd = document.createElement("td");
			iconTd.setAttribute("scope", "row");
			iconTd.innerHTML = getTargetSvg(target); // SVG content is safe (from our code)
			tr.appendChild(iconTd);

			// Name cell
			const nameTh = document.createElement("th");
			nameTh.textContent = target.name;
			if (target.alarmIsMuted) {
				const muteIcon = document.createElement("i");
				muteIcon.className = "bi bi-volume-mute-fill";
				nameTh.appendChild(document.createTextNode(" "));
				nameTh.appendChild(muteIcon);
			}
			tr.appendChild(nameTh);

			// Data cells
			const cells = [
				target.bearingFormatted,
				target.rangeFormatted,
				target.sogFormatted,
				target.cpa ? target.cpaFormatted : "",
				target.cpa ? target.tcpaFormatted : "",
			];
			for (const cellText of cells) {
				const td = document.createElement("td");
				td.className = "text-end";
				td.textContent = cellText;
				tr.appendChild(td);
			}

			fragment.appendChild(tr);
			rowCount++;
		}
	}

	const tableBody = document.getElementById("tableOfTargetsBody");
	tableBody.textContent = ""; // Clear safely
	tableBody.appendChild(fragment);
	document.getElementById("numberOfAisTargets").textContent = rowCount;
}

function getTargetSvg(target) {
	// fishing
	if (target.typeId === 30) {
		return targetSvgs.fishingboatSvg;
	}

	// sailing
	else if (target.typeId === 36) {
		return targetSvgs.sailboatSvg;
	}

	// pleasure
	else if (target.typeId === 37) {
		return targetSvgs.powerboatSvg;
	}

	// sar
	else if (
		target.typeId === 51 ||
		target.mmsi.startsWith("111") ||
		target.mmsi.startsWith("970") ||
		target.mmsi.startsWith("972") ||
		target.mmsi.startsWith("974")
	) {
		return targetSvgs.sarSvg;
	}

	// tug
	else if (target.typeId === 52) {
		return targetSvgs.tugboatSvg;
	}

	// other class A
	else if (target.aisClass === "A") {
		return targetSvgs.shipSvg;
	}

	// aton
	else if (target.aisClass === "ATON" || target.mmsi.startsWith("99")) {
		return targetSvgs.atonSvg;
	}

	// everything else
	else return targetSvgs.ufoSvg;
}

function updateSingleVesselUI(target) {
	// dont update (and dont add back in) old targets
	if (!target.isValid) {
		return;
	}

	let boatMarker = boatMarkers.get(target.mmsi);
	let boatProjectedCourseLine = boatProjectedCourseLines.get(target.mmsi);

	if (!boatMarker) {
		const icon = getTargetIcon(target, false, "gray");

		boatMarker = L.marker([0, 0], { icon: icon, riseOnHover: true }).addTo(map);
		boatMarkers.set(target.mmsi, boatMarker);

		boatMarker.bindTooltip("", {
			permanent: true,
			direction: "right",
			opacity: 0.7,
			offset: [25, 10],
			className: "map-labels",
			interactive: false,
			zIndexOffset: -999,
		});

		if (target.mmsi !== selfMmsi) {
			boatMarker.on("click", boatClicked);
		}

		boatProjectedCourseLine = L.polyline([[]], {
			color: "gray",
			opacity: 0.7,
			interactive: false,
			dashArray: "20 10",
			zIndexOffset: -999,
		}).addTo(map);
		boatProjectedCourseLines.set(target.mmsi, boatProjectedCourseLine);
	}

	boatMarker.setLatLng([target.latitude, target.longitude]);

	let vesselIconColor;
	let vesselIconIsLarge;

	if (target.mmsi === selectedVesselMmsi) {
		vesselIconColor = "blue";
		vesselIconIsLarge = true;
	} else if (target.alarmState === "danger") {
		vesselIconColor = "red";
		vesselIconIsLarge = true;
	} else if (target.alarmState === "warning") {
		vesselIconColor = "orange";
		vesselIconIsLarge = true;
	} else {
		vesselIconColor = "gray";
		vesselIconIsLarge = false;
	}

	boatMarker.setIcon(getTargetIcon(target, vesselIconIsLarge, vesselIconColor));

	// move the blue box with the selected boat over time
	if (target.mmsi === selectedVesselMmsi && blueBoxIcon) {
		blueBoxIcon.setLatLng([target.latitude, target.longitude]);
	}

	// store the whole vessel data model on the boat marker
	boatMarker.mmsi = target.mmsi;

	// Future: Add ATON-specific data for popup (isOffPosition indicator, yellow box styling)

	if (target.mmsi !== selfMmsi) {
		// update counts
		validTargetCount++;
		if (target.alarmState) {
			filteredTargetCount++;
			if (target.alarmState === "danger") {
				alarmTargetCount++;
			}
		}

		// add tooltip text
		let tooltipText = `${target.name}<br/>`;
		if (target.sog > 0.1) {
			tooltipText += `${target.sogFormatted} `;
		}
		if (target.cpa) {
			tooltipText += `${target.cpaFormatted} `;
		}
		if (target.tcpa > 0 && target.tcpa < 3600) {
			tooltipText += target.tcpaFormatted;
		}
		// ensure the tooltip is always 2 rows - to prevent onscreen jumpiness
		tooltipText += "&nbsp";
		boatMarker.setTooltipContent(tooltipText);
		addLabelToCollisionController(boatMarker, target.mmsi, target.order);
	}

	// if this is our vessel and another vessel has been selected
	// draw a solid blue line to cpa point from our vessel
	// Note: Self vessel is processed first, so selected vessel may not be in targets yet during initial load
	if (target.mmsi === selfMmsi && selectedVesselMmsi) {
		//console.log(selectedVesselMmsi, targets.get(selectedVesselMmsi));
		const projectedCpaLocation = projectedLocation(
			[target.latitude, target.longitude],
			target.cog || 0,
			(target.sog || 0) * (targets.get(selectedVesselMmsi).tcpa || 0),
		);

		boatProjectedCourseLine.setLatLngs([
			[target.latitude, target.longitude],
			projectedCpaLocation,
		]);

		boatProjectedCourseLine.setStyle({
			color: "blue",
			opacity: 1.0,
			interactive: false,
			dashArray: "",
			className: "blueStuff",
		});

		blueCircle1.setLatLng(projectedCpaLocation);

		if (!map.hasLayer(blueCircle1)) {
			blueCircle1.addTo(map);
		}
	}

	// if this is the selected vessel
	// draw solid blue line to the cpa point from selected vessel
	else if (selectedVesselMmsi === target.mmsi) {
		const projectedCpaLocation = projectedLocation(
			[target.latitude, target.longitude],
			target.cog || 0,
			(target.sog || 0) * (target.tcpa || 0),
		);

		boatProjectedCourseLine.setLatLngs([
			[target.latitude, target.longitude],
			projectedCpaLocation,
		]);

		boatProjectedCourseLine.setStyle({
			color: "blue",
			opacity: 1.0,
			interactive: false,
			dashArray: "",
			className: "blueStuff",
		});

		blueCircle2.setLatLng(projectedCpaLocation);

		if (!map.hasLayer(blueCircle2)) {
			blueCircle2.addTo(map);
		}
	}

	// all other vessels (not our vessel and not a selected vessel)
	// draw dashed gray line to course projected position
	// but do orange or red depending on alarm state
	else {
		boatProjectedCourseLine.setLatLngs([
			[target.latitude, target.longitude],
			projectedLocation(
				[target.latitude, target.longitude],
				target.cog || 0,
				(target.sog || 0) * 60 * COURSE_PROJECTION_MINUTES,
			),
		]);

		boatProjectedCourseLine.setStyle({
			color: vesselIconColor,
			opacity: 0.7,
			interactive: false,
			dashArray: "20 10",
		});
	}
}

function ageOutOldTargets() {
	targets.forEach((target, mmsi) => {
		// dont age ourselves out. should never happen, but...
		if (mmsi === selfMmsi) {
			return;
		}

		if (target.lastSeen > TARGET_MAX_AGE) {
			console.log(
				"aging out old target",
				mmsi,
				target.name,
				target.mmsi,
				target.lastSeen / 60,
			);

			if (mmsi === selectedVesselMmsi) {
				blueBoxIcon.removeFrom(map);
				blueCircle1.removeFrom(map);
				blueCircle2.removeFrom(map);
				bsModalSelectedVesselProperties.hide();
				selectedVesselMmsi = null;
			}

			if (boatMarkers.has(mmsi)) {
				const marker = boatMarkers.get(mmsi);
				marker.unbindTooltip(); // Prevent memory leak
				marker.off(); // Remove all event listeners
				marker.removeFrom(map);
				boatMarkers.delete(mmsi);
			}

			if (boatProjectedCourseLines.has(mmsi)) {
				boatProjectedCourseLines.get(mmsi).removeFrom(map);
				boatProjectedCourseLines.delete(mmsi);
			}
			labelToCollisionController.removeLabel(mmsi, null);
			targets.delete(mmsi);
		}
	});
}

function boatClicked(event) {
	//console.log('event', event);
	const boatMarker = event.target;
	const closebyBoatMarkers = findClosebyBoats(event.latlng);
	if (closebyBoatMarkers.length > 1) {
		closebyBoatMarkers.sort((a, b) => a.distanceInPixels - b.distanceInPixels);

		const div = document.getElementById("listOfClosebyBoats");
		div.textContent = "";
		let target;
		let a;

		closebyBoatMarkers.forEach((closebyBoatMarker, i) => {
			target = targets.get(closebyBoatMarker.mmsi);
			//console.log(i, target.name, target.alarmState, closebyBoatMarker.distanceInPixels);
			a = document.createElement("a");
			a.href = "#";
			a.setAttribute("data-bs-toggle", "list");
			a.setAttribute("data-mmsi", target.mmsi);
			// list-group-item-danger list-group-item-warning
			a.classList = "list-group-item list-group-item-action";
			if (i === 0) {
				a.classList.add("active");
			}
			if (target.alarmState === "danger") {
				a.classList.add("list-group-item-danger");
			} else if (target.alarmState === "warning") {
				a.classList.add("list-group-item-warning");
			}
			a.appendChild(document.createTextNode(target.name));
			div.appendChild(a);
		});
		selectBoatMarker(closebyBoatMarkers[0]);
		positionModalWindow(boatMarker.getLatLng(), "modalClosebyBoats");
		bsModalClosebyBoats.show();
		return;
	}

	selectBoatMarker(boatMarker);
	positionModalWindow(boatMarker.getLatLng(), "modalSelectedVesselProperties");
	showModalSelectVesselProperties(targets.get(boatMarker.mmsi));
}

function showModalSelectVesselProperties(target) {
	updateSelectedVesselProperties(target);
	alertPlaceholder.textContent = "";
	bsModalSelectedVesselProperties.show();
}

function positionModalWindow(latLng, modalId) {
	const clickedBoatMarkerLocationInPixels = map.latLngToContainerPoint(latLng);
	const mapWidthInPixels = document.getElementById("map").clientWidth;

	// if its a narrow screen, show modal in the default centered manner
	// if boat is right of center, place modal on left
	// if boat is left of center, place modal on right
	const modalDialog = document.getElementById(modalId).children[0];
	if (mapWidthInPixels > 600) {
		if (clickedBoatMarkerLocationInPixels.x > mapWidthInPixels / 2) {
			modalDialog.style.marginLeft = "100px";
			modalDialog.style.marginRight = "auto";
		} else {
			modalDialog.style.marginLeft = "auto";
			modalDialog.style.marginRight = "100px";
		}
	} else {
		modalDialog.removeAttribute("style");
	}
}

function findClosebyBoats(latLng) {
	const mapHeightInPixels = map.getSize().y;
	const mapHeightInMeters =
		Math.abs(map.getBounds().getNorth() - map.getBounds().getSouth()) *
		60 *
		METERS_PER_NM;
	const mapScaleMetersPerPixel = mapHeightInMeters / mapHeightInPixels;
	const closebyBoatMarkers = [];
	boatMarkers.forEach((boatMarker, mmsi) => {
		if (mmsi === selfMmsi) {
			return;
		}
		const distanceInMeters = latLng.distanceTo(boatMarker.getLatLng());
		const distanceInPixels = distanceInMeters / mapScaleMetersPerPixel;
		if (distanceInPixels < 30) {
			boatMarker.distanceInPixels = distanceInPixels;
			closebyBoatMarkers.push(boatMarker);
		}
	});

	return closebyBoatMarkers;
}

function handleListOfClosebyBoatsClick(event) {
	//console.log(event);
	const boatMarker = boatMarkers.get(event.target.dataset.mmsi);
	selectBoatMarker(boatMarker);
}

function selectBoatMarker(boatMarker) {
	// if my own boat was selected - quit
	// if clicking on the boat that is already selected - quit
	if (boatMarker.mmsi === selfMmsi || boatMarker.mmsi === selectedVesselMmsi) {
		return;
	}

	// add blue box to selected boat marker
	blueBoxIcon.setLatLng(boatMarker.getLatLng());
	blueBoxIcon.addTo(map);

	// bring boat to front - on top of the blue box - so that the boat can be clicked rather than the blue box
	boatMarker.setZIndexOffset(1000);

	let oldSelectedVesselMmsi;

	// get vessel that was selected before this new selection (if any)
	if (selectedVesselMmsi) {
		oldSelectedVesselMmsi = selectedVesselMmsi;
	}

	selectedVesselMmsi = boatMarker.mmsi;
	updateSingleVesselUI(targets.get(selectedVesselMmsi));

	if (oldSelectedVesselMmsi) {
		updateSingleVesselUI(targets.get(oldSelectedVesselMmsi));
	}
}

function handleMapClick() {
	blueBoxIcon.removeFrom(map);
	blueCircle1.removeFrom(map);
	blueCircle2.removeFrom(map);

	if (selectedVesselMmsi) {
		// update selected vessel (remove blue):
		const savedSelectedVesselMmsi = selectedVesselMmsi;
		selectedVesselMmsi = null;
		updateSingleVesselUI(targets.get(savedSelectedVesselMmsi));
		// update own vessel (remove blue):
		updateSingleVesselUI(targets.get(selfMmsi));
	}
}

function getTargetIcon(target, isLarge, color) {
	// self
	if (target.mmsi === selfMmsi) {
		return aisIons.getSelfIcon();
	}
	// 111MIDXXX        SAR (Search and Rescue) aircraft
	// 970MIDXXX        AIS SART (Search and Rescue Transmitter)
	// 972XXXXXX        MOB (Man Overboard) device
	// 974XXXXXX        EPIRB (Emergency Position Indicating Radio Beacon) AIS
	else if (
		target.mmsi.startsWith("111") ||
		target.mmsi.startsWith("970") ||
		target.mmsi.startsWith("972") ||
		target.mmsi.startsWith("974")
	) {
		return aisIons.getSartIcon();
	}
	// 99MIDXXXX        Aids to Navigation
	else if (target.aisClass === "ATON" || target.mmsi.startsWith("99")) {
		return aisIons.getAtonIcon(target, isLarge, color);
	}
	// class A
	else if (target.aisClass === "A") {
		return aisIons.getClassAIcon(target, isLarge, color);
	}
	// BASE
	else if (target.aisClass === "BASE") {
		return aisIons.getBaseIcon(target, isLarge, color);
	}
	// class B
	else {
		return aisIons.getClassBIcon(target, isLarge, color);
	}
}

function addLabelToCollisionController(layer, id, weight) {
	const label = layer.getTooltip()._source._tooltip._container;
	if (label) {
		const rect = label.getBoundingClientRect();

		const bottomLeft = map.containerPointToLatLng([rect.left, rect.bottom]);
		const topRight = map.containerPointToLatLng([rect.right, rect.top]);
		const boundingBox = {
			bottomLeft: [bottomLeft.lng, bottomLeft.lat],
			topRight: [topRight.lng, topRight.lat],
		};

		labelToCollisionController.ingestLabel(
			boundingBox,
			id,
			-weight,
			label,
			id, // name
			false, //being dragged
		);
	}
}

function projectedLocation(start, θ, distance) {
	const radius = 6371e3; // (Mean) radius of earth in meters
	const [lat, lon] = start;

	// sinφ2 = sinφ1·cosδ + cosφ1·sinδ·cosθ
	// tanΔλ = sinθ·sinδ·cosφ1 / cosδ−sinφ1·sinφ2
	// see mathforum.org/library/drmath/view/52049.html for derivation

	const δ = Number(distance) / radius; // angular distance in radians

	const φ1 = toRadians(Number(lat));
	const λ1 = toRadians(Number(lon));

	const sinφ1 = Math.sin(φ1),
		cosφ1 = Math.cos(φ1);
	const sinδ = Math.sin(δ),
		cosδ = Math.cos(δ);
	const sinθ = Math.sin(θ),
		cosθ = Math.cos(θ);

	const sinφ2 = sinφ1 * cosδ + cosφ1 * sinδ * cosθ;
	const φ2 = Math.asin(sinφ2);
	const y = sinθ * sinδ * cosφ1;
	const x = cosδ - sinφ1 * sinφ2;
	const λ2 = λ1 + Math.atan2(y, x);

	return [toDegrees(φ2), ((toDegrees(λ2) + 540) % 360) - 180]; // normalise to −180..+180°
}

async function getHttpResponse(url, options) {
	let response;
	let jsonResponse;
	try {
		response = await fetch(url, { credentials: "include" });
		if (response.status === 401) {
			location.href = "/admin/#/login";
		}
		if (!response.ok) {
			if (response.status === 404 && options?.ignore404) {
				//  ignore 404s if so directed
			} else {
				console.error(`Response status: ${response.status} from ${url}`);
				if (options?.throwErrors) {
					throw new Error(`Response status: ${response.status} from ${url}`);
				}
			}
		} else {
			const textResponse = await response.text();
			if (textResponse) {
				jsonResponse = JSON.parse(textResponse);
			} else if (!options?.ignoreEmptyResponse) {
				throw new Error(`Error: Got empty json response from ${url}`);
			}
		}
	} catch (error) {
		console.error(
			`Error in getHttpResponse: url=${url}, options=${options}, status=${
				response?.status || "none"
			}`,
			error,
		);
		if (options?.throwErrors) {
			//showError("The SignalK AIS Target Prioritizer plugin is not running. Please check the plugin status.");
			showError(`Encountered an error retrieving data from the SignalK server. Verify that you are connected to the SignalK server, that the SignalK 
                server is running, and that the AIS Target Prioritizer plugin is enabled.`);
			// <br><br>
			// 	<b>url</b>=${url},<br><b>options</b>=${JSON.stringify(
			// 	options,
			// 	)},<br><b>status</b>=${response?.status || "none"},<br><b>error</b>=${
			// 	error.message
			// 	}`);
			throw new Error(
				`Error in getHttpResponse: url=${url}, options=${JSON.stringify(
					options,
				)}, status=${response?.status || "none"}, error=${error.message}`,
			);
		}
	}
	return jsonResponse;
}
