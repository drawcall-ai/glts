import { LoadingManager } from "three";

function unavailable(): never {
  throw new Error(
    "@drawcall/glts loadingManager is only available inside a .glts module loaded by GLTSLoader"
  );
}

export const loadingManager: LoadingManager = new Proxy(new LoadingManager(), {
  get: unavailable,
  set: unavailable
});
