import { GLTSLoader } from "@drawcall/glts";
import { Group, LoadingManager } from "three";

declare global {
  interface Window {
    readonly GLTSLoader: typeof GLTSLoader;
    readonly Group: typeof Group;
    readonly LoadingManager: typeof LoadingManager;
  }
}

Object.defineProperties(window, {
  GLTSLoader: { value: GLTSLoader },
  Group: { value: Group },
  LoadingManager: { value: LoadingManager }
});
