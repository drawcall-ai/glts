import type * as THREE from "three";

export type GLTSURL = string | URL;

export type GLTSFetch = (
  input: RequestInfo | URL,
  init?: RequestInit
) => Promise<Response>;

export interface GLTSLoaderOptions {
  baseURL?: GLTSURL;
  cdnURL?: GLTSURL;
  fetch?: GLTSFetch;
  isPreview?: boolean;
}

type GLTSGroup = Omit<THREE.Group, "clone"> & {
  clone(recursive?: boolean): THREE.Group;
};

export type GLTSScene = GLTSGroup & {
  readonly url: string;
  dispose(): void;
  reload(): Promise<void>;
  update(delta: number): void;
};

interface GLTSInstanceMethods {
  readonly count: number;
  readonly url: string;
  dispose(): void;
  getMatrixAt(index: number, matrix: THREE.Matrix4): THREE.Matrix4;
  reload(): Promise<void>;
  setMatrixAt(index: number, matrix: THREE.Matrix4): this;
  update(delta: number): void;
}

export type GLTSInstances = GLTSGroup & GLTSInstanceMethods;

export type GLTSMatrixUpdateCallback = (
  index: number,
  matrix: THREE.Matrix4
) => void;

export type GLTSFrameCallback = (delta: number) => void;
export type GLTSDisposeCallback = () => void;
export type GLTSLoadCallback = (scene: GLTSScene) => void;
export type GLTSProgressCallback = (event: ProgressEvent<EventTarget>) => void;
export type GLTSErrorCallback = (error: unknown) => void;

export interface GLTSScriptLoader {
  loadAsync(url: GLTSURL): Promise<GLTSScene>;
  loadInstancesAsync(url: GLTSURL, count: number): Promise<GLTSInstances>;
}
