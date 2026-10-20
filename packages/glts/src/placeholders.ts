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

export const scene: GLTSScriptScene = new Proxy(createRoot(), {
  get: () => unavailable("scene"),
  set: () => unavailable("scene")
});

export const loadingManager: LoadingManager = new Proxy(new LoadingManager(), {
  get: () => unavailable("loadingManager"),
  set: () => unavailable("loadingManager")
});

export const gltsLoader: GLTSContextLoader = {
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
