export {
  gltsLoader,
  instanceCount,
  loadingManager,
  onDispose,
  onFrame,
  onMatrixUpdateAt,
  isPreview,
  scene
} from "./placeholders.js";
export { GLTSError, type GLTSPhase } from "./errors.js";
export { GLTSLoader } from "./loader/index.js";
export { GLTSRenderer } from "./renderer/index.js";
export type {
  GLTSEffect,
  GLTSEffectContext,
  GLTSInstances,
  GLTSLoaderOptions,
  GLTSRenderingProfile,
  GLTSScene,
  GLTSSource
} from "./types.js";

export { getGLTSSource } from "./execution/current.js";
