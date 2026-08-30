import { GLTSLoader } from "@drawcall/glts";
import { Group, LoadingManager } from "three";

declare global {
  interface Window {
    readonly GLTSLoader: typeof GLTSLoader;
    readonly Group: typeof Group;
    readonly LoadingManager: typeof LoadingManager;
  }
}

Object.defineProperty(window, "GLTSLoader", {
  configurable: false,
  enumerable: false,
  value: GLTSLoader,
  writable: false
});

Object.defineProperty(window, "Group", {
  configurable: false,
  enumerable: false,
  value: Group,
  writable: false
});

Object.defineProperty(window, "LoadingManager", {
  configurable: false,
  enumerable: false,
  value: LoadingManager,
  writable: false
});
