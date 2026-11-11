import type * as THREE from "three";

import type { GLTSDisposeCallback, GLTSFrameCallback, GLTSScriptLoader, GLTSScriptScene } from "./types.js";

export { disposeRecursive } from "./dispose.js";
export { GLTSError, type GLTSPhase } from "./errors.js";
export { GLTSLoader } from "./loader/index.js";
export { GLTSRenderer } from "./renderer/index.js";
export type {
  GLTSCluster,
  GLTSEffect,
  GLTSEffectContext,
  GLTSInstances,
  GLTSLoaderOptions,
  GLTSModuleSource,
  GLTSRenderingProfile,
  GLTSScene,
  GLTSSource
} from "./types.js";

// Contextual bindings: a script's imports of them are compiled to its execution's values, so no module provides them.

/** The script's root scene; follows the stable loaded scene after reload. */
export declare const scene: GLTSScriptScene;

/** Pass to resource loaders during script evaluation to track their requests. */
export declare const loadingManager: THREE.LoadingManager;

/**
 * Loads nested assets relative to this script, which owns each result, attached beneath scene or not, until it disposes
 * it. A failed nested load fails this script too, even when the script catches it. Loads after the script finished,
 * such as a library's on demand, are not part of its load and fail only themselves.
 */
export declare const gltsLoader: GLTSScriptLoader;

/** True only for a preview loader's directly loaded scene, never nested scenes or instances. */
export declare const isPreview: boolean;

/** Runs on disposal or replacement by reload, in reverse registration order. */
export declare function onDispose(callback: GLTSDisposeCallback): void;

/** Runs when the host updates this scene; delta is elapsed simulation time in seconds. */
export declare function onFrame(callback: GLTSFrameCallback): void;
