import {
  DefaultLoadingManager,
  Loader,
  type LoadingManager
} from "three";
import * as THREE from "three";

import { GLTSError } from "./errors.js";
import { canonicalGLTSURL, ModuleGraph, threeRevision } from "./module-graph.js";
import { ModuleURLStore } from "./module-url-store.js";
import { WrapperRuntime } from "./runtime.js";
import type {
  GLTSAsset,
  GLTSErrorCallback,
  GLTSFetch,
  GLTSLoadCallback,
  GLTSLoaderOptions,
  GLTSProgressCallback
} from "./types.js";

function environmentBaseURL(): URL {
  if (typeof document !== "undefined") {
    return new URL(document.baseURI);
  }

  if (typeof location !== "undefined") {
    return new URL(location.href);
  }

  return new URL("http://localhost/");
}

function resolvedOptionURL(value: string | URL | undefined, fallback: string, base: URL): URL {
  return new URL(value ?? fallback, base);
}

class GLTSAssetHandle implements GLTSAsset {
  readonly scene: THREE.Group;
  readonly url: string;
  readonly #reloadAsset: () => Promise<void>;
  readonly #disposeAsset: () => void;
  #disposed = false;

  constructor(
    scene: THREE.Group,
    url: string,
    reloadAsset: () => Promise<void>,
    disposeAsset: () => void
  ) {
    this.scene = scene;
    this.url = url;
    this.#reloadAsset = reloadAsset;
    this.#disposeAsset = disposeAsset;
  }

  async reload(): Promise<void> {
    if (this.#disposed) {
      throw new GLTSError("Asset handle has been disposed", {
        url: this.url,
        phase: "reload"
      });
    }

    await this.#reloadAsset();
  }

  dispose(): void {
    if (this.#disposed) {
      return;
    }

    this.#disposed = true;
    this.#disposeAsset();
  }
}

export class GLTSLoader extends Loader {
  readonly #baseURL: URL;
  readonly #baseFetch: GLTSFetch;
  readonly #runtime: WrapperRuntime;
  readonly #graph: ModuleGraph;
  readonly #assets = new Set<GLTSAssetHandle>();
  readonly #reloadQueues = new Map<string, Promise<void>>();
  #disposed = false;

  constructor(
    manager: LoadingManager = DefaultLoadingManager,
    options: GLTSLoaderOptions = {}
  ) {
    super(manager);

    const environmentBase = environmentBaseURL();
    this.#baseURL = resolvedOptionURL(options.baseURL, environmentBase.href, environmentBase);
    this.#baseFetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));

    const moduleURLs = new ModuleURLStore();
    this.#runtime = new WrapperRuntime(moduleURLs);
    this.#graph = new ModuleGraph({
      cdnURL: resolvedOptionURL(options.cdnURL, "https://esm.sh/", this.#baseURL),
      fetch: (input, init) => this.#fetch(input, init),
      moduleURLs,
      runtime: this.#runtime,
      threeRevision: threeRevision(THREE)
    });
  }

  override load(
    url: string,
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

  override async loadAsync(url: string, onProgress?: GLTSProgressCallback): Promise<GLTSAsset> {
    this.#assertActive(url);
    void onProgress;
    const resolvedURL = this.#resolveURL(url);

    return this.#trackLoading(resolvedURL, async () => {
      try {
        const prepared = await this.#graph.prepareAsset(
          resolvedURL,
          { activate: true, force: false }
        );
        const scene = await this.#runtime.loadRoot(prepared.url);
        this.#graph.retainRoot(prepared.url);
        let handle: GLTSAssetHandle;
        handle = new GLTSAssetHandle(
          scene,
          prepared.url,
          () => this.reload(prepared.url),
          () => {
            try {
              this.#runtime.disposeWrapper(scene);
            } finally {
              this.#graph.releaseRoot(prepared.url);
              this.#assets.delete(handle);
            }
          }
        );
        this.#assets.add(handle);
        return handle;
      } finally {
        this.#graph.settleReachability();
      }
    });
  }

  has(url: string): boolean {
    return this.#graph.hasAsset(this.#resolveURL(url));
  }

  async reload(url: string): Promise<void> {
    this.#assertActive(url);
    const resolvedURL = this.#resolveURL(url);
    const previous = this.#reloadQueues.get(resolvedURL) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() =>
      this.#trackLoading(resolvedURL, async () => {
        try {
          const prepared = await this.#graph.prepareAsset(
            resolvedURL,
            { activate: false, force: true }
          );
          try {
            this.#runtime.replace(resolvedURL, prepared.assetClass);
          } catch (error) {
            if (error instanceof GLTSError && error.phase === "dispose") {
              // Disposal begins only after WrapperRuntime commits the replacement.
              this.#graph.activateAsset(prepared);
            }
            throw error;
          }
          this.#graph.activateAsset(prepared);
        } finally {
          this.#graph.settleReachability();
        }
      })
    );

    this.#reloadQueues.set(resolvedURL, next);
    try {
      await next;
    } finally {
      if (this.#reloadQueues.get(resolvedURL) === next) {
        this.#reloadQueues.delete(resolvedURL);
      }
    }
  }

  dispose(): void {
    if (this.#disposed) {
      return;
    }

    const errors: unknown[] = [];
    for (const asset of [...this.#assets]) {
      try {
        asset.dispose();
      } catch (error) {
        errors.push(error);
      }
    }

    try {
      this.#runtime.dispose();
    } catch (error) {
      errors.push(error);
    }

    this.#disposed = true;
    if (errors.length > 0) {
      throw new GLTSError(
        "Loader disposal failed",
        { url: "glts://loader", phase: "dispose" },
        new AggregateError(errors)
      );
    }
  }

  async #trackLoading<T>(url: string, operation: () => Promise<T>): Promise<T> {
    this.manager.itemStart(url);

    try {
      return await operation();
    } catch (error) {
      this.manager.itemError(url);
      throw error;
    } finally {
      this.manager.itemEnd(url);
    }
  }

  #resolveURL(url: string): string {
    const managedURL = this.manager.resolveURL(`${this.path}${url}`);
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

  #assertActive(url: string): void {
    if (!this.#disposed) {
      return;
    }

    throw new GLTSError("Loader has been disposed", {
      url,
      phase: "resolve"
    });
  }
}
