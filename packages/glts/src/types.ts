import type * as THREE from "three/webgpu";

export type GLTSURL = string | URL;

/** Host namespaces by exact bare specifier, imported by scripts instead of the CDN. */
export type GLTSModules = Readonly<Record<string, object>>;

/**
 * Resolves a bare specifier to a specifier or URL the host's `import()` resolves, such as with the host's
 * `import.meta.resolve`; linked modules import what it returns natively. Return undefined to use the CDN.
 */
export type GLTSResolve = (specifier: string) => string | undefined;

export interface GLTSLoaderOptions {
  /** CDN for packages not supplied by the host. Defaults to https://esm.sh/. */
  cdnURL?: GLTSURL;
  /** Enables preview staging for directly loaded scenes. Defaults to false. */
  isPreview?: boolean;
  /** Host namespaces shared with scripts by exact import specifier. */
  modules?: GLTSModules;
  /** Resolves unversioned packages natively instead of through the CDN. */
  resolve?: GLTSResolve;
  /** Additional package names CDN bundles import separately, sharing the host's resolver and other CDN packages. */
  external?: readonly string[];
  /** Values exposed as import.meta.env in linked scripts, helpers, and CDN modules; absent unless supplied by the host. */
  env?: Readonly<Record<string, string | boolean>>;
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

/** Source files observed by one script run, shared by getGLTSSource() and the loaded scene's source. */
export interface GLTSSource {
  /** Script source URL after redirects. */
  readonly url: string;
  /**
   * URLs observed so far for helpers, nested scripts, and resources requested through the script's
   * loadingManager, transitively. Each read returns a frozen, sorted snapshot, following nested reloads.
   * Excludes this script's own URLs, packages, and requests outside that manager.
   */
  readonly dependencyUrls: readonly string[];
}

interface GLTSSceneMethods {
  /** Resolved URL originally requested from the loader, before redirects. */
  readonly url: string;
  /** The current run's source; replaced on root reload. Retained sources belong to their original run. */
  readonly source: GLTSSource;
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

/** A managed scene whose source metadata follows reloads and remains readable after disposal. */
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

export interface GLTSScriptLoader {
  loadAsync(url: GLTSURL): Promise<GLTSScene>;
  loadInstancesAsync(url: GLTSURL, count: number): Promise<GLTSInstances>;
}
