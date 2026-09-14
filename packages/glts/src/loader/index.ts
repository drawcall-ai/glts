import {
  Loader,
  type LoadingManager
} from "three";
import * as THREE from "three";

import { GLTSError } from "../errors.js";
import { createContextLoader } from "./context.js";
import { LoaderRuntime } from "./runtime.js";
import { canonicalGLTSURL, ScriptModules } from "../modules/scripts.js";
import { ModuleBridge } from "../modules/bridge.js";
import { ModuleURLStore } from "../modules/urls.js";
import type {
  GLTSErrorCallback,
  GLTSFetch,
  GLTSInstances,
  GLTSLoadCallback,
  GLTSLoaderOptions,
  GLTSProgressCallback,
  GLTSScene,
  GLTSURL
} from "../types.js";

function environmentBaseURL(): URL {
  if (typeof document !== "undefined") {
    return new URL(document.baseURI);
  }

  if (typeof location !== "undefined") {
    return new URL(location.href);
  }

  return new URL("http://localhost/");
}

function resolvedOptionURL(value: GLTSURL | undefined, fallback: string, base: URL): URL {
  return new URL(value ?? fallback, base);
}

export class GLTSLoader extends Loader {
  readonly #isPreview: boolean;
  readonly #baseURL: URL;
  readonly #baseFetch: GLTSFetch;
  readonly #runtime: LoaderRuntime;
  readonly #bridge: ModuleBridge;
  #disposed = false;

  constructor(
    manager: LoadingManager,
    options: GLTSLoaderOptions = {}
  ) {
    super(manager);
    if (!manager) {
      throw new TypeError("GLTSLoader requires a Three.js LoadingManager");
    }

    this.#isPreview = options.isPreview ?? false;
    const environmentBase = environmentBaseURL();
    const baseURL = resolvedOptionURL(options.baseURL, environmentBase.href, environmentBase);
    const moduleURLs = new ModuleURLStore();
    const moduleBridge = new ModuleBridge(moduleURLs);
    const baseFetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.#baseURL = baseURL;
    this.#baseFetch = baseFetch;
    this.#bridge = moduleBridge;

    const modules = new ScriptModules({
      cdnURL: resolvedOptionURL(options.cdnURL, "https://esm.sh/", baseURL),
      fetch: (input, init) => this.#fetch(input, init),
      moduleURLs,
      bridge: moduleBridge,
      threeRevision: THREE.REVISION
    });
    this.#runtime = new LoaderRuntime({
      physicsWorld: options.physicsWorld,
      contextLoader: (owner) => createContextLoader(owner, this.#runtime, (url) => this.#resolveURL(url, "")),
      manager,
      modules
    });
  }

  override load(
    url: GLTSURL,
    onLoad: GLTSLoadCallback,
    onProgress?: GLTSProgressCallback,
    onError?: GLTSErrorCallback
  ): void {
    void this.loadAsync(url, onProgress).then(onLoad, (error: unknown) => {
      if (onError) {
        onError(error);
        return;
      }

      console.error(error);
    });
  }

  override loadAsync(
    url: GLTSURL,
    onProgress?: GLTSProgressCallback
  ): Promise<GLTSScene> {
    const resolvedURL = this.#resolveURL(url);
    if (onProgress) {
      return Promise.reject(new GLTSError(
        "GLTSLoader does not support per-load progress callbacks; use LoadingManager.onProgress",
        { phase: "resolve", url: resolvedURL }
      ));
    }
    return this.#runtime.load(resolvedURL, this.#isPreview);
  }

  loadInstancesAsync(url: GLTSURL, count: number): Promise<GLTSInstances> {
    return this.#runtime.loadInstances(this.#resolveURL(url), count, this.#isPreview);
  }

  /** Invalidates source and reloads undisposed nodes. Unloaded source is fetched on the next load. */
  reload(url: GLTSURL): Promise<void> {
    return this.#runtime.reload(this.#resolveURL(url));
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    const errors: unknown[] = [];
    try {
      this.#runtime.dispose();
    } catch (error) {
      errors.push(error);
    }
    try {
      this.#bridge.dispose();
    } catch (error) {
      errors.push(error);
    }

    if (errors.length > 0) {
      throw new GLTSError(
        "Loader disposal failed",
        { phase: "dispose", url: "glts://loader" },
        new AggregateError(errors)
      );
    }
  }

  #resolveURL(url: GLTSURL, path = this.path): string {
    const input = url instanceof URL ? url.href : `${path}${url}`;
    const managedURL = this.manager.resolveURL(input);
    return canonicalGLTSURL(managedURL, this.#baseURL);
  }

  #fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const headers = new Headers(init?.headers);
    for (const [name, value] of Object.entries(this.requestHeader)) {
      headers.set(name, value);
    }

    const requestInit: RequestInit = { ...init, headers };
    if (this.withCredentials) {
      requestInit.credentials = "include";
    }

    return this.#baseFetch(input, requestInit);
  }

}
