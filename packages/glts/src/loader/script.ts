import * as THREE from "three";

import { GLTSError } from "../errors.js";
import type { GLTSInstances, GLTSModuleSource, GLTSScene, GLTSScriptLoader, GLTSURL } from "../types.js";

type GLTSLoadCallback = (scene: GLTSScene) => void;
type GLTSProgressCallback = (event: ProgressEvent<EventTarget>) => void;
type GLTSErrorCallback = (error: unknown) => void;

/**
 * A script's contextual `gltsLoader`: a Three.js loader of its contextual `loadingManager`, so a library given that
 * manager can load `.glts` files through it as a handler, as through the host's GLTSLoader.
 */
export class ScriptLoader extends THREE.Loader<GLTSScene, GLTSURL> implements GLTSScriptLoader {
  readonly #load: (url: string) => Promise<GLTSScene>;
  readonly #loadInstances: (url: string, count: number) => Promise<GLTSInstances>;

  constructor(
    manager: THREE.LoadingManager,
    readonly moduleSources: Readonly<Record<string, GLTSModuleSource>>,
    load: (url: string) => Promise<GLTSScene>,
    loadInstances: (url: string, count: number) => Promise<GLTSInstances>,
  ) {
    super(manager);
    this.#load = load;
    this.#loadInstances = loadInstances;
  }

  override load(url: GLTSURL, onLoad: GLTSLoadCallback, onProgress?: GLTSProgressCallback, onError?: GLTSErrorCallback): void {
    void this.loadAsync(url, onProgress).then(onLoad, onError ?? ((error: unknown) => console.error(error)));
  }

  override async loadAsync(url: GLTSURL, onProgress?: GLTSProgressCallback): Promise<GLTSScene> {
    if (onProgress) {
      throw new GLTSError("gltsLoader does not support per-load progress callbacks; use LoadingManager.onProgress", {
        phase: "resolve", url: String(url),
      });
    }
    return this.#load(this.#path(url));
  }

  async loadInstancesAsync(url: GLTSURL, count: number): Promise<GLTSInstances> {
    return this.#loadInstances(this.#path(url), count);
  }

  #path(url: GLTSURL): string {
    return url instanceof URL ? url.href : `${this.path}${url}`;
  }
}
