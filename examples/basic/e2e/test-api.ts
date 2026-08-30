import { GLTSLoader } from "@drawcall/glts";
import { Group, LoadingManager } from "three";

function readErrorField(error: unknown, key: PropertyKey): unknown {
  return typeof error === "object" && error !== null ? Reflect.get(error, key) : undefined;
}

declare global {
  interface Window {
    readonly GLTSLoader: typeof GLTSLoader;
    readonly Group: typeof Group;
    readonly LoadingManager: typeof LoadingManager;
    readonly readErrorField: typeof readErrorField;
  }
}

Object.defineProperties(window, {
  GLTSLoader: { value: GLTSLoader },
  Group: { value: Group },
  LoadingManager: { value: LoadingManager },
  readErrorField: { value: readErrorField }
});
