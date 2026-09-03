import {
  Loader,
  type LoadingManager
} from "three";
import * as THREE from "three";

import { GLTSError } from "./errors.js";
import type { Execution } from "./execution.js";
import { LoaderRuntime } from "./loader-runtime.js";
import { canonicalGLTSURL, ModuleGraph } from "./module-graph.js";
import { ModuleRuntime } from "./runtime.js";
import { ModuleURLStore } from "./module-url-store.js";
import type {
  GLTSErrorCallback,
  GLTSFetch,
  GLTSInstances,
  GLTSLoadCallback,
  GLTSLoaderOptions,
  GLTSProgressCallback,
  GLTSScene,
  GLTSURL
} from "./types.js";

const internalLoader = Symbol("internal GLTS loader");

interface SharedRuntime {
  readonly baseFetch: GLTSFetch;
  readonly baseURL: URL;
  disposed: boolean;
  readonly hostLoader: GLTSLoader;
  loaderRuntime: LoaderRuntime | undefined;
  readonly moduleRuntime: ModuleRuntime;
}

interface InternalLoaderOptions extends GLTSLoaderOptions {
  readonly [internalLoader]: SharedRuntime;
  readonly owner: Execution;
}

function isInternalOptions(
  options: GLTSLoaderOptions
): options is InternalLoaderOptions {
  return internalLoader in options;
}

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
  readonly #contextual: boolean;
  readonly #isPreview: boolean;
  readonly #owner: Execution | undefined;
  readonly #shared: SharedRuntime;

  constructor(
    manager: LoadingManager,
    options: GLTSLoaderOptions = {}
  ) {
    super(manager);
    if (!manager) {
      throw new TypeError("GLTSLoader requires a Three.js LoadingManager");
    }

    if (isInternalOptions(options)) {
      this.#contextual = true;
      this.#isPreview = false;
      this.#owner = options.owner;
      this.#shared = options[internalLoader];
      return;
    }

    this.#contextual = false;
    this.#isPreview = options.isPreview ?? false;
    this.#owner = undefined;
    const environmentBase = environmentBaseURL();
    const baseURL = resolvedOptionURL(options.baseURL, environmentBase.href, environmentBase);
    const moduleURLs = new ModuleURLStore();
    const moduleRuntime = new ModuleRuntime(moduleURLs);
    const baseFetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    const shared: SharedRuntime = {
      baseFetch,
      baseURL,
      disposed: false,
      hostLoader: this,
      loaderRuntime: undefined,
      moduleRuntime
    };
    this.#shared = shared;

    const modules = new ModuleGraph({
      cdnURL: resolvedOptionURL(options.cdnURL, "https://esm.sh/", baseURL),
      fetch: (input, init) => this.#fetch(input, init),
      moduleURLs,
      runtime: moduleRuntime,
      threeRevision: THREE.REVISION
    });
    shared.loaderRuntime = new LoaderRuntime({
      contextLoader: (owner) => {
        const contextOptions: InternalLoaderOptions = {
          [internalLoader]: shared,
          owner
        };
        return new GLTSLoader(manager, contextOptions);
      },
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
    this.#owner?.assertCanLoad(resolvedURL);
    return this.#ownNode(
      this.#loaderRuntime().load(resolvedURL, this.#isPreview, this.#owner)
    );
  }

  loadInstancesAsync(url: GLTSURL, count: number): Promise<GLTSInstances> {
    const resolvedURL = this.#resolveURL(url);
    this.#owner?.assertCanLoad(resolvedURL);
    return this.#ownNode(
      this.#loaderRuntime().loadInstances(
        resolvedURL,
        count,
        this.#isPreview,
        this.#owner
      )
    );
  }

  reload(url: GLTSURL): Promise<void> {
    if (this.#contextual) {
      return this.#track(Promise.reject(new GLTSError(
        "The contextual gltsLoader cannot reload the live graph",
        { phase: "reload", url: "glts://context-loader" }
      )));
    }

    const resolvedURL = this.#resolveURL(url);
    return this.#loaderRuntime().reload(resolvedURL);
  }

  dispose(): void {
    if (this.#contextual) {
      throw new GLTSError("The contextual gltsLoader cannot be disposed by a script", {
        phase: "dispose",
        url: "glts://context-loader"
      });
    }

    if (this.#shared.disposed) {
      return;
    }

    this.#shared.disposed = true;
    const errors: unknown[] = [];
    try {
      this.#loaderRuntime().dispose();
    } catch (error) {
      errors.push(error);
    }
    try {
      this.#shared.moduleRuntime.dispose();
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

  #resolveURL(url: GLTSURL): string {
    const input = url instanceof URL ? url.href : `${this.path}${url}`;
    const managedURL = this.manager.resolveURL(input);
    return canonicalGLTSURL(managedURL, this.#shared.baseURL);
  }

  #fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const headers = new Headers(init?.headers);
    for (const [name, value] of Object.entries(this.#shared.hostLoader.requestHeader)) {
      headers.set(name, value);
    }

    const requestInit: RequestInit = { ...init, headers };
    if (this.#shared.hostLoader.withCredentials) {
      requestInit.credentials = "include";
    }

    return this.#shared.baseFetch(input, requestInit);
  }

  #loaderRuntime(): LoaderRuntime {
    const runtime = this.#shared.loaderRuntime;
    if (runtime) {
      return runtime;
    }

    throw new Error("GLTS loader runtime has not been initialized");
  }

  #ownNode<T extends GLTSInstances | GLTSScene>(promise: Promise<T>): Promise<T> {
    const owner = this.#owner;
    if (!owner) {
      return promise;
    }

    const owned = promise.then((value) => {
      try {
        owner.own(value);
      } catch (error) {
        try {
          value.dispose();
        } catch (cleanup) {
          throw new GLTSError(
            "Nested GLTS ownership and cleanup both failed",
            { phase: "dispose", url: value.url },
            new AggregateError([error, cleanup])
          );
        }
        throw error;
      }
      return value;
    });
    return owner.track(owned);
  }

  #track<T>(promise: Promise<T>): Promise<T> {
    return this.#owner?.track(promise) ?? promise;
  }
}
