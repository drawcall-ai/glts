import * as THREE from "three";

import { GLTSError } from "./errors.js";
import type { GLTSPreviewExports } from "./types.js";

interface ModuleContext {
  readonly url: string;
  readonly importChain: readonly string[];
}

const absent = Symbol("absent preview export");

function moduleExport(namespace: unknown, name: string): unknown | typeof absent {
  if (
    (typeof namespace !== "object" && typeof namespace !== "function") ||
    namespace === null ||
    !Object.hasOwn(namespace, name)
  ) {
    return absent;
  }

  return Reflect.get(namespace, name);
}

function receivedType(value: unknown): string {
  if (value === null) {
    return "null";
  }

  if (value instanceof THREE.Object3D) {
    return `THREE.${value.type}`;
  }

  return typeof value;
}

function readCamera(namespace: unknown, context: ModuleContext): THREE.Camera | undefined {
  const value = moduleExport(namespace, "previewCamera");
  if (value === absent) {
    return undefined;
  }

  if (value instanceof THREE.Camera) {
    return value;
  }

  throw new GLTSError(
    `Named export "previewCamera" must be a THREE.Camera; received ${receivedType(value)}`,
    { ...context, phase: "evaluate" }
  );
}

function containsLight(object: THREE.Object3D): boolean {
  let found = false;
  object.traverse((child) => {
    if (child instanceof THREE.Light) {
      found = true;
    }
  });
  return found;
}

function readLighting(
  namespace: unknown,
  context: ModuleContext
): THREE.Object3D | undefined {
  const value = moduleExport(namespace, "previewLighting");
  if (value === absent) {
    return undefined;
  }

  if (!(value instanceof THREE.Object3D)) {
    throw new GLTSError(
      `Named export "previewLighting" must be a THREE.Object3D containing at least one THREE.Light; received ${receivedType(value)}`,
      { ...context, phase: "evaluate" }
    );
  }

  if (!containsLight(value)) {
    throw new GLTSError(
      `Named export "previewLighting" must contain at least one THREE.Light; received ${receivedType(value)} with no lights`,
      { ...context, phase: "evaluate" }
    );
  }

  return value;
}

export function readPreviewExports(
  namespace: unknown,
  context: ModuleContext
): GLTSPreviewExports {
  return {
    previewCamera: readCamera(namespace, context),
    previewLighting: readLighting(namespace, context)
  };
}
