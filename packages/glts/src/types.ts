import type * as THREE from "three";

export type GLTSAssetClass = new () => THREE.Object3D;

export type GLTSFetch = (
  input: RequestInfo | URL,
  init?: RequestInit
) => Promise<Response>;

export interface GLTSLoaderOptions {
  baseURL?: string | URL;
  cdnURL?: string | URL;
  fetch?: GLTSFetch;
}

export interface GLTSAsset {
  readonly scene: THREE.Group;
  readonly url: string;
  reload(): Promise<void>;
  dispose(): void;
}

export type GLTSLoadCallback = (asset: GLTSAsset) => void;
export type GLTSProgressCallback = (event: ProgressEvent<EventTarget>) => void;
export type GLTSErrorCallback = (error: unknown) => void;
