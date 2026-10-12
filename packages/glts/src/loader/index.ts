import {
  Loader,
  type LoadingManager
} from "three";

import { GLTSError, runAll } from "../errors.js";
import { createContextLoader } from "./context.js";
import { LoaderRuntime } from "./runtime.js";
import { ScriptModules } from "../modules/scripts.js";
import { canonicalize } from "../modules/fetch.js";
import { defaultCDNURL } from "../modules/resolution.js";
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
  readonly #modules: ScriptModules;
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
    const baseFetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.#baseURL = baseURL;
    this.#baseFetch = baseFetch;
    this.#modules = new ScriptModules({
      cdnURL: resolvedOptionURL(options.cdnURL, defaultCDNURL, baseURL),
      fetch: (input, init) => this.#fetch(input, init),
      modules: options.modules
    });
    this.#runtime = new LoaderRuntime({
      contextLoader: (owner) => createContextLoader(owner, this.#runtime, (url) => this.#resolveURL(url, "")),
      manager,
      modules: this.#modules
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

  /**
   * Invalidates the source of the script at `url`, or of every script importing the helper at `url`,
   * and reloads their undisposed nodes. Unloaded source is fetched on the next load.
   */
  reload(url: GLTSURL): Promise<void> {
    return this.#runtime.reload(this.#resolveURL(url));
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    try {
      runAll("Loader disposal failed", [() => this.#runtime.dispose(), () => this.#modules.dispose()]);
    } catch (error) {
      throw new GLTSError("Loader disposal failed", { phase: "dispose", url: "glts://loader" }, error);
    }
  }

  #resolveURL(url: GLTSURL, path = this.path): string {
    const input = url instanceof URL ? url.href : `${path}${url}`;
    const managedURL = this.manager.resolveURL(input);
    return canonicalize(new URL(managedURL, this.#baseURL));
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
