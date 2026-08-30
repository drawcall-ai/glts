import {
  DefaultLoadingManager,
  Loader,
  type LoadingManager
} from "three";
import * as THREE from "three";

import type { PreviewState } from "./asset-exports.js";
import { GLTSError } from "./errors.js";
import {
  canonicalGLTSURL,
  ModuleGraph,
  type PreparedAsset,
  threeRevision
} from "./module-graph.js";
import { ModuleURLStore } from "./module-url-store.js";
import { RootOwnership } from "./root.js";
import { WrapperRuntime } from "./runtime.js";
import type {
  GLTSAsset,
  GLTSConstructor,
  GLTSErrorCallback,
  GLTSFetch,
  GLTSInstance,
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
  #previewCamera: THREE.Camera | undefined;
  #previewLighting: THREE.Object3D | undefined;
  #disposed = false;

  constructor(
    scene: THREE.Group,
    url: string,
    preview: PreviewState,
    reloadAsset: () => Promise<void>,
    disposeAsset: () => void
  ) {
    this.scene = scene;
    this.url = url;
    this.#previewCamera = preview.previewCamera;
    this.#previewLighting = preview.previewLighting;
    this.#reloadAsset = reloadAsset;
    this.#disposeAsset = disposeAsset;
  }

  get previewCamera(): THREE.Camera | undefined {
    return this.#previewCamera;
  }

  get previewLighting(): THREE.Object3D | undefined {
    return this.#previewLighting;
  }

  updatePreview(preview: PreviewState): void {
    this.#previewCamera = preview.previewCamera;
    this.#previewLighting = preview.previewLighting;
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

interface PreparedConstructor extends PreviewState {
  readonly Constructor: GLTSConstructor;
  readonly url: string;
}

export class GLTSLoader extends Loader {
  readonly #baseURL: URL;
  readonly #baseFetch: GLTSFetch;
  readonly #runtime: WrapperRuntime;
  readonly #graph: ModuleGraph;
  readonly #assets = new Set<GLTSAssetHandle>();
  readonly #constructors = new Map<string, GLTSConstructor>();
  readonly #roots = new Set<RootOwnership>();
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
    void onProgress;
    return this.#withConstructor(url, async (prepared) => {
      const instance = new prepared.Constructor();
      await instance.ready;
      let handle: GLTSAssetHandle;
      handle = new GLTSAssetHandle(
        instance,
        prepared.url,
        prepared,
        () => this.reload(prepared.url),
        () => {
          try {
            instance.dispose();
          } finally {
            this.#assets.delete(handle);
          }
        }
      );
      this.#assets.add(handle);
      return handle;
    });
  }

  loadAsyncConstructor(url: string): Promise<GLTSConstructor> {
    return this.#withConstructor(url, (prepared) => prepared.Constructor);
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
          this.#activateAsset(prepared);
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

    this.#disposed = true;
    const reason = new GLTSError("Loader was disposed before the instance became ready", {
      url: "glts://loader",
      phase: "dispose"
    });
    const errors: unknown[] = [];
    for (const root of [...this.#roots]) {
      try {
        root.dispose(reason);
      } catch (error) {
        errors.push(error);
      }
    }

    try {
      this.#runtime.dispose();
    } catch (error) {
      errors.push(error);
    }

    if (errors.length > 0) {
      throw new GLTSError(
        "Loader disposal failed",
        { url: "glts://loader", phase: "dispose" },
        new AggregateError(errors)
      );
    }
  }

  async #withConstructor<T>(
    url: string,
    use: (prepared: PreparedConstructor) => T | Promise<T>
  ): Promise<T> {
    this.#assertActive(url);
    const resolvedURL = this.#resolveURL(url);

    return this.#trackLoading(resolvedURL, async () => {
      try {
        const prepared = await this.#prepareConstructor(resolvedURL);
        return await use(prepared);
      } finally {
        this.#graph.settleReachability();
      }
    });
  }

  async #prepareConstructor(url: string): Promise<PreparedConstructor> {
    const prepared = await this.#graph.prepareAsset(
      url,
      { activate: true, force: false }
    );
    this.#assertActive(prepared.url);
    const existing = this.#constructors.get(prepared.url);
    if (existing) {
      return { Constructor: existing, ...prepared };
    }

    const loader = this;
    class ManagedGLTSInstance extends THREE.Group implements GLTSInstance {
      readonly ready: Promise<void>;
      readonly #ownership: RootOwnership;

      constructor() {
        super();
        this.#ownership = loader.#mountInstance(this, prepared.url);
        this.ready = this.#ownership.ready;
      }

      dispose(): void {
        this.#ownership.dispose(new GLTSError(
          "Instance was disposed before it became ready",
          { url: prepared.url, phase: "dispose" }
        ));
      }
    }

    this.#constructors.set(prepared.url, ManagedGLTSInstance);
    return { Constructor: ManagedGLTSInstance, ...prepared };
  }

  #mountInstance(instance: THREE.Group, url: string): RootOwnership {
    this.#assertActive(url);
    const root = this.#runtime.mountRoot(instance, url);
    try {
      this.#graph.retainRoot(url);
    } catch (error) {
      root.dispose(error);
      throw error;
    }

    const ownership = new RootOwnership(root, url, (released) => {
      try {
        this.#graph.releaseRoot(url);
      } finally {
        this.#roots.delete(released);
      }
    });
    this.#roots.add(ownership);
    return ownership;
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

  #activateAsset(prepared: PreparedAsset): void {
    this.#graph.activateAsset(prepared);
    for (const asset of this.#assets) {
      if (asset.url === prepared.url) {
        asset.updatePreview(prepared);
      }
    }
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
