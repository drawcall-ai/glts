import type { LoadingManager } from "three";

function unavailable(): never {
  throw new Error(
    "@drawcall/glts/asset is only available inside a GLTS asset module"
  );
}

export const loadingManager: LoadingManager = unavailable();
