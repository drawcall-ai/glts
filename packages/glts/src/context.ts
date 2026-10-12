import { LoadingManager } from "three";

import type {
  GLTSDisposeCallback,
  GLTSFrameCallback,
  GLTSMatrixUpdateCallback,
  GLTSScriptLoader
} from "./types.js";
import { createScriptScene, type GLTSScriptScene } from "./scene/root.js";

function unavailable(name: string): never {
  throw new Error(
    `@drawcall/glts ${name} is only available inside a .glts script loaded by GLTSLoader`
  );
}

export const scene: GLTSScriptScene = new Proxy(createScriptScene(), {
  get: () => unavailable("scene"),
  set: () => unavailable("scene")
});

export const loadingManager: LoadingManager = new Proxy(new LoadingManager(), {
  get: () => unavailable("loadingManager"),
  set: () => unavailable("loadingManager")
});

export const gltsLoader: GLTSScriptLoader = {
  loadAsync: () => unavailable("gltsLoader"),
  loadInstancesAsync: () => unavailable("gltsLoader")
};

// Annotated so scripts may compare them with any value when type checked.
export const instanceCount: number = 1;
export const isPreview: boolean = false;

export function onDispose(_callback: GLTSDisposeCallback): void {
  unavailable("onDispose");
}

export function onFrame(_callback: GLTSFrameCallback): void {
  unavailable("onFrame");
}

export function onMatrixUpdateAt(_callback: GLTSMatrixUpdateCallback): void {
  unavailable("onMatrixUpdateAt");
}
