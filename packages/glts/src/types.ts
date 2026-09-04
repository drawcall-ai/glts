import type * as THREE from "three";
import type { GLTSScriptScene } from "./rendering.js";

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

interface GLTSSceneMethods {
  readonly url: string;
  add(...objects: THREE.Object3D[]): this;
  applyQuaternion(quaternion: THREE.Quaternion): this;
  attach(object: THREE.Object3D): this;
  clear(): this;
  clone(recursive?: boolean): THREE.Scene;
  copy(source: THREE.Scene, recursive?: boolean): this;
  dispose(): void;
  reload(): Promise<void>;
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
export type GLTSLoadCallback = (scene: GLTSScene) => void;
export type GLTSProgressCallback = (event: ProgressEvent<EventTarget>) => void;
export type GLTSErrorCallback = (error: unknown) => void;

export interface GLTSScriptLoader {
  loadAsync(url: GLTSURL): Promise<GLTSScene>;
  loadInstancesAsync(url: GLTSURL, count: number): Promise<GLTSInstances>;
}
