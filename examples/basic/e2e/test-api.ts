import { GLTSLoader } from "@drawcall/glts";

declare global {
  interface Window {
    readonly GLTSLoader: typeof GLTSLoader;
  }
}

Object.defineProperty(window, "GLTSLoader", {
  configurable: false,
  enumerable: false,
  value: GLTSLoader,
  writable: false
});
