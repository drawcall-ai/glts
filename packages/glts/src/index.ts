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
export type {
  GLTSEffect,
  GLTSEffectContext,
  GLTSRenderingProfile
} from "./scene/root.js";
export type {
  GLTSDisposeCallback,
  GLTSErrorCallback,
  GLTSFetch,
  GLTSFrameCallback,
  GLTSInstances,
  GLTSLoadCallback,
  GLTSLoaderOptions,
  GLTSMatrixUpdateCallback,
  GLTSModules,
  GLTSProgressCallback,
  GLTSScene,
  GLTSScriptLoader,
  GLTSURL
} from "./types.js";
