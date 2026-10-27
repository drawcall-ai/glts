import type * as THREE from "three/webgpu";

export type GLTSURL = string | URL;

/** Host namespaces by exact bare specifier, imported by scripts instead of the CDN. */
export type GLTSModules = Readonly<Record<string, object>>;

/**
 * Resolves a bare specifier to a specifier or URL the host's `import()` resolves, such as with the host's
 * `import.meta.resolve`; linked modules import what it returns natively.
 */
export type GLTSResolve = (specifier: string) => string;

export interface GLTSLoaderOptions {
  /** CDN for packages not supplied by the host. Defaults to https://esm.sh/. */
  cdnURL?: GLTSURL;
  /** Enables preview staging for directly loaded scenes. Defaults to false. */
  isPreview?: boolean;
  /** Host namespaces shared with scripts by exact import specifier. */
  modules?: GLTSModules;
  /** Resolves unversioned packages natively instead of through the CDN. */
  resolve?: GLTSResolve;
}

export interface GLTSEffectContext {
  /** The previous effect's linear RGBA output, or the rendered scene for the first effect. */
  readonly input: THREE.Node<"vec4">;
  readonly camera: THREE.Camera;
  /** Initial drawing-buffer height in pixels. */
  readonly height: number;
  readonly scene: GLTSScriptScene;
  /** Initial drawing-buffer width in pixels. */
  readonly width: number;
}

/**
 * Creates an effect graph owned and disposed by GLTS. Create its resource nodes inside the factory.
 * Three.js addons such as bloom can retain custom node-update callbacks after disposal. Animate script
 * uniforms with onFrame instead to avoid keeping script state in those callbacks.
 */
export type GLTSEffect = (context: GLTSEffectContext) => THREE.Node<"vec4">;

/** How GLTSRenderer configures the renderer for a scene. */
export interface GLTSRenderingProfile {
  effects: GLTSEffect[];
  shadows: boolean;
  toneMapping: THREE.ToneMapping;
  toneMappingExposure: number;
}

/** What a script's root adds to a THREE.Scene. */
export interface RootState {
  /** Recommended camera, used by GLTSRenderer when the host does not supply one. */
  defaultCamera: THREE.Camera | undefined;
  readonly rendering: GLTSRenderingProfile;
}

/** The `scene` scripts build, whose `clone()` makes a plain scene. */
export type GLTSScriptScene = Omit<THREE.Scene, "clone"> & RootState & {
  clone(recursive?: boolean): THREE.Scene;
};

interface GLTSSceneMethods {
  /** Resolved source URL. */
  readonly url: string;
  add(...objects: THREE.Object3D[]): this;
  applyQuaternion(quaternion: THREE.Quaternion): this;
  attach(object: THREE.Object3D): this;
  clear(): this;
  clone(recursive?: boolean): THREE.Scene;
  copy(source: THREE.Scene, recursive?: boolean): this;
  /** Disposes this execution, nested scenes, and GLTSRenderer effect graphs. */
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
  /** Advances frame callbacks of this scene and its nested scenes by delta seconds. */
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
