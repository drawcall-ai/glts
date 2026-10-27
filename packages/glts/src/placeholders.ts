import { LoadingManager } from "three";

import type {
  GLTSDisposeCallback,
  GLTSFrameCallback,
  GLTSMatrixUpdateCallback,
  GLTSContextLoader,
  GLTSScriptScene
} from "./types.js";
import { createRoot } from "./root.js";
import type { ContextName } from "./imports.js";
import type * as Placeholders from "./placeholders.js";

// Compiles only while the exports are exactly the names scripts import as contextual values.
type Same<A, B> = [A] extends [B] ? [B] extends [A] ? true : false : false;
type Assert<T extends true> = T;
type Checked = Assert<Same<keyof typeof Placeholders, ContextName>>;

function unavailable(name: string): never {
  throw new Error(
    `@drawcall/glts ${name} is only available inside a .glts script loaded by GLTSLoader`
  );
}

/** The script's root scene; follows the stable loaded scene after reload. */
export const scene: GLTSScriptScene = new Proxy(createRoot(), {
  get: () => unavailable("scene"),
  set: () => unavailable("scene")
});

/** Pass to resource loaders during script evaluation to track their requests. */
export const loadingManager: LoadingManager = new Proxy(new LoadingManager(), {
  get: () => unavailable("loadingManager"),
  set: () => unavailable("loadingManager")
});

/** Loads nested assets relative to this script. Attach each result beneath scene. */
export const gltsLoader: GLTSContextLoader = {
  loadAsync: () => unavailable("gltsLoader"),
  loadInstancesAsync: () => unavailable("gltsLoader")
};

// Annotated so scripts may compare them with any value when type checked.
/** Requested instance count, or 1 for a plain scene load. */
export const instanceCount: number = 1;
/** True only for a preview loader's directly loaded scene, never nested scenes or instances. */
export const isPreview: boolean = false;

/** Runs on disposal or replacement by reload, in reverse registration order. */
export function onDispose(_callback: GLTSDisposeCallback): void {
  unavailable("onDispose");
}

/** Runs when the host updates this scene; delta is elapsed simulation time in seconds. */
export function onFrame(_callback: GLTSFrameCallback): void {
  unavailable("onFrame");
}

/** Opts into authored instancing, receiving current matrices immediately and subsequent host updates. */
export function onMatrixUpdateAt(_callback: GLTSMatrixUpdateCallback): void {
  unavailable("onMatrixUpdateAt");
}
