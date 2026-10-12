export {
  gltsLoader,
  instanceCount,
  loadingManager,
  onDispose,
  onFrame,
  onMatrixUpdateAt,
  isPreview,
  scene
} from "./context.js";
export { GLTSError, type GLTSPhase } from "./errors.js";
export { GLTSLoader } from "./loader/index.js";
export { GLTSRenderer } from "./renderer/index.js";
export type { GLTSEffect, GLTSRenderingProfile } from "./scene/root.js";
export type { GLTSInstances, GLTSLoaderOptions, GLTSScene } from "./types.js";
