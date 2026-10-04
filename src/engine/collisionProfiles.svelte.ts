// src/engine/collisionProfiles.svelte.ts

import type { CollisionProfiles, CollisionProfile } from "../types";
import {
  cloneCollisionProfiles,
  isValidCollisionProfiles,
} from "./validateCollisionProfiles";

const defaultCollisionProfiles: CollisionProfiles = {
  current: "offshore",
  anchor: {
    warning: {
      cpa: 0,
      tcpa: 60,
      speed: 0,
    },
    danger: {
      cpa: 0,
      tcpa: 60,
      speed: 0,
    },
    guard: {
      range: 0,
      speed: 0,
    },
  },
  harbor: {
    warning: {
      cpa: 0.5,
      tcpa: 10,
      speed: 0.5,
    },
    danger: {
      cpa: 0.1,
      tcpa: 5,
      speed: 3,
    },
    guard: {
      range: 0,
      speed: 0,
    },
  },
  coastal: {
    warning: {
      cpa: 2,
      tcpa: 30,
      speed: 0,
    },
    danger: {
      cpa: 1,
      tcpa: 10,
      speed: 0.5,
    },
    guard: {
      range: 0,
      speed: 0,
    },
  },
  offshore: {
    warning: {
      cpa: 4,
      tcpa: 30,
      speed: 0,
    },
    danger: {
      cpa: 2,
      tcpa: 15,
      speed: 0,
    },
    guard: {
      range: 0,
      speed: 0,
    },
  },
};

// $state proxies the object it is handed, so it gets a copy. sharing the object
// would make every edit to the store an edit to the defaults as well, leaving
// resetCollisionProfiles with nothing original to restore.
export const collisionProfiles = $state<CollisionProfiles>(
  structuredClone(defaultCollisionProfiles),
);

// throws on anything that is not a complete, in-range profile set, leaving the
// store untouched - the plugin feeds this straight from a request body and from a
// file on disk, and a bad value would otherwise break alarm evaluation for every
// target.
export function setCollisionProfiles(data: unknown) {
  if (!isValidCollisionProfiles(data)) {
    throw new Error("invalid collision profiles");
  }
  Object.assign(collisionProfiles, cloneCollisionProfiles(data));
}

export function resetCollisionProfiles() {
  console.warn("resetting collision profiles");
  setCollisionProfiles(structuredClone(defaultCollisionProfiles));
}

export function getActiveCollisionProfileName(): string {
  return collisionProfiles.current;
}

export function getActiveCollisionProfile(): CollisionProfile {
  return collisionProfiles[collisionProfiles.current];
}
