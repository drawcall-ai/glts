import { LoadingManager } from "three";

import type {
  GLTSDisposeCallback,
  GLTSFrameCallback,
  GLTSScriptLoader,
  GLTSScriptScene
} from "./types.js";
import { ScriptLoader } from "./loader/script.js";
import { createRoot } from "./root.js";

// Context-free, so scripts and hosts share one implementation.
export { disposeRecursive } from "./dispose.js";

function unavailable(name: string): never {
  throw new Error(
    `@drawcall/glts ${name} is only available inside a .glts script loaded by GLTSLoader`
  );
}

/** The script's root scene; follows the stable loaded scene after reload. */
export const scene: GLTSScriptScene = new Proxy(createRoot({ url: "glts:context", packages: [], moduleHashes: {}, runtimeModules: [], dependencyUrls: [] }), {
  get: () => unavailable("scene"),
  set: () => unavailable("scene")
});

/** Pass to resource loaders during script evaluation to track their requests. */
export const loadingManager: LoadingManager = new Proxy(new LoadingManager(), {
  get: () => unavailable("loadingManager"),
  set: () => unavailable("loadingManager")
});

/**
 * Loads nested assets relative to this script, which owns each result, attached beneath scene or not, until it disposes
 * it. A failed nested load fails this script too, even when the script catches it. Loads after the script finished,
 * such as a library's on demand, are not part of its load and fail only themselves.
 */
export const gltsLoader: GLTSScriptLoader = new Proxy(
  new ScriptLoader(new LoadingManager(), {}, () => unavailable("gltsLoader"), () => unavailable("gltsLoader")),
  { get: () => unavailable("gltsLoader"), set: () => unavailable("gltsLoader") }
);

// Annotated so scripts may compare it with any value when type checked.
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
