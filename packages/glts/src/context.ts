import type {
  GLTSDisposeCallback,
  GLTSFrameCallback,
  GLTSInstances,
  GLTSMatrixUpdateCallback,
  GLTSScene,
  GLTSScriptLoader,
  GLTSURL
} from "./types.js";
import { createScene, type GLTSScriptScene } from "./rendering.js";

function unavailable(name: string): never {
  throw new Error(
    `@drawcall/glts ${name} is only available inside a .glts script loaded by GLTSLoader`
  );
}

export const scene: GLTSScriptScene = new Proxy(createScene(), {
  get: () => unavailable("scene"),
  set: () => unavailable("scene")
});

class UnavailableScriptLoader implements GLTSScriptLoader {
  loadAsync(_url: GLTSURL): Promise<GLTSScene> {
    return unavailable("gltsLoader");
  }

  loadInstancesAsync(_url: GLTSURL, _count: number): Promise<GLTSInstances> {
    return unavailable("gltsLoader");
  }
}

export const gltsLoader: GLTSScriptLoader = new UnavailableScriptLoader();
export const instanceCount = 1;
export const isPreview = false;

export function onDispose(_callback: GLTSDisposeCallback): void {
  unavailable("onDispose");
}

export function onFrame(_callback: GLTSFrameCallback): void {
  unavailable("onFrame");
}

export function onMatrixUpdateAt(_callback: GLTSMatrixUpdateCallback): void {
  unavailable("onMatrixUpdateAt");
}
