import type * as THREE from "three";
import type { Pass } from "three/addons/postprocessing/Pass.js";

export type GLTSURL = string | URL;

/** Host namespaces by exact bare specifier, imported by scripts instead of the CDN. */
export type GLTSModules = Readonly<Record<string, object>>;

/**
 * Resolves a bare specifier to a specifier or URL the host's `import()` resolves, such as with the host's
 * `import.meta.resolve`; linked modules import what it returns natively.
 */
export type GLTSResolve = (specifier: string) => string;

export interface GLTSLoaderOptions {
  cdnURL?: GLTSURL;
  isPreview?: boolean;
  modules?: GLTSModules;
  resolve?: GLTSResolve;
}

export interface GLTSEffectContext {
  readonly camera: THREE.Camera;
  readonly height: number;
  readonly scene: GLTSScriptScene;
  readonly width: number;
}

export type GLTSEffect = (context: GLTSEffectContext) => Pass;

/** How GLTSRenderer configures the renderer for a scene. */
export interface GLTSRenderingProfile {
  effects: GLTSEffect[];
  localClippingEnabled: boolean;
  shadows: boolean;
  toneMapping: THREE.ToneMapping;
  toneMappingExposure: number;
}

/** What a script's root adds to a THREE.Scene. */
export interface RootState {
  defaultCamera: THREE.Camera | undefined;
  readonly rendering: GLTSRenderingProfile;
}

/** The `scene` scripts build, whose `clone()` makes a plain scene. */
export type GLTSScriptScene = Omit<THREE.Scene, "clone"> & RootState & {
  clone(recursive?: boolean): THREE.Scene;
};

interface GLTSSceneMethods {
  readonly url: string;
  add(...objects: THREE.Object3D[]): this;
  applyQuaternion(quaternion: THREE.Quaternion): this;
  attach(object: THREE.Object3D): this;
  clear(): this;
  clone(recursive?: boolean): THREE.Scene;
  copy(source: THREE.Scene, recursive?: boolean): this;
  dispose(): void;
  remove(...objects: THREE.Object3D[]): this;
  removeFromParent(): this;
  rotateOnAxis(axis: THREE.Vector3, angle: number): this;
  rotateOnWorldAxis(axis: THREE.Vector3, angle: number): this;
  rotateX(angle: number): this;
  rotateY(angle: number): this;
  rotateZ(angle: number): this;
  translateOnAxis(axis: THREE.Vector3, distance: number): this;
  translateX(distance: number): this;
  translateY(distance: number): this;
  translateZ(distance: number): this;
  update(delta: number): void;
}

export type GLTSScene =
  Omit<GLTSScriptScene, keyof GLTSSceneMethods> & GLTSSceneMethods;

interface GLTSInstanceMethods {
  readonly count: number;
  getMatrixAt(index: number, matrix: THREE.Matrix4): THREE.Matrix4;
  setMatrixAt(index: number, matrix: THREE.Matrix4): this;
}

export type GLTSInstances = GLTSScene & GLTSInstanceMethods;

export type GLTSMatrixUpdateCallback = (
  index: number,
  matrix: THREE.Matrix4
) => void;

export type GLTSFrameCallback = (delta: number) => void;
export type GLTSDisposeCallback = () => void;

export interface GLTSContextLoader {
  loadAsync(url: GLTSURL): Promise<GLTSScene>;
  loadInstancesAsync(url: GLTSURL, count: number): Promise<GLTSInstances>;
}

/** The capabilities of one script execution, returned by the exposed but undocumented `getGLTSContext()`. */
export interface GLTSContext {
  readonly url: string;
  /** Observed helper files, nested scripts, and resources requested through `loadingManager`; a frozen snapshot on each read. */
  readonly dependencies: readonly string[];
  readonly gltsLoader: GLTSContextLoader;
  readonly instanceCount: number;
  readonly loadingManager: THREE.LoadingManager;
  readonly onDispose: (callback: GLTSDisposeCallback) => void;
  readonly onFrame: (callback: GLTSFrameCallback) => void;
  readonly onMatrixUpdateAt: (callback: GLTSMatrixUpdateCallback) => void;
  readonly isPreview: boolean;
  readonly scene: GLTSScriptScene;
}
