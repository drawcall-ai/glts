import * as THREE from "three";
import * as TSL from "three/tsl";
import * as WebGPU from "three/webgpu";

import { aggregate, cleanUpAndThrow, GLTSError, runAll, toGLTSError } from "../errors.js";
import { Dependencies } from "../dependencies.js";
import { Execution } from "../execution/index.js";
import { withFiles } from "../files.js";
import * as GLTS from "../index.js";
import { gltsSpecifier, type ProvidedSpecifier } from "../imports.js";
import { Linker, type Script } from "../linker/index.js";
import { defaultCDNURL } from "../linker/resolution.js";
import { NodeRegistry, type LoadRequest } from "../node.js";
import type { GLTSInstances, GLTSLoaderOptions, GLTSModules, GLTSModuleSource, GLTSScene, GLTSURL } from "../types.js";
import { canonicalize, pageURL } from "../urls.js";
import { trackItem, type ItemFailure } from "./items.js";
import { LoadScope, type NestedLoader } from "./scope.js";
import { resolveWarmup, type WarmupScripts } from "./warmup.js";

/** The namespaces scripts share with the host, including Three's core, WebGPU, and TSL modules. */
function hostModules(modules: GLTSModules = {}): GLTSModules {
  const provided: Record<ProvidedSpecifier, object> = {
    three: THREE,
    "three/webgpu": WebGPU,
    "three/tsl": TSL,
    // The package CDN and npm packages import, with the host's overrides.
    [gltsSpecifier]: { ...GLTS, ...modules[gltsSpecifier] },
  };
  return { ...modules, ...provided };
}

type GLTSLoadCallback = (scene: GLTSScene) => void;
type GLTSProgressCallback = (event: ProgressEvent<EventTarget>) => void;
type GLTSErrorCallback = (error: unknown) => void;

export class GLTSLoader extends THREE.Loader {
  /** Current bundled namespace provenance, available without fetching scripts. Runtime CDN imports are absent. */
  readonly moduleSources: Readonly<Record<string, GLTSModuleSource>>;
  readonly #isPreview: boolean;
  readonly #linker: Linker;
  readonly #lifetime = new AbortController();
  readonly #nodes = new NodeRegistry();
  readonly #nested: NestedLoader = {
    loadAsync: (url, scope) => this.#load(url, undefined, scope),
    loadInstancesAsync: (url, count, scope) => this.#load(url, count, scope)
  };
  /** The unsettled loads of each requested URL. */
  readonly #loads = new Map<string, Set<Promise<unknown>>>();
  /** Reloads run one at a time, in request order. */
  #lastReload: Promise<void> = Promise.resolve();

  constructor(
    manager: THREE.LoadingManager,
    options: GLTSLoaderOptions = {}
  ) {
    super(manager);
    if (!manager) {
      throw new TypeError("GLTSLoader requires a Three.js LoadingManager");
    }

    this.moduleSources = options.moduleSources ?? {};
    this.#isPreview = options.isPreview ?? false;
    this.#linker = new Linker({
      cdnURL: pageURL(options.cdnURL ?? defaultCDNURL),
      fetch: withFiles((input, init) => this.#fetch(input, init)),
      modules: hostModules(options.modules),
      moduleSources: this.moduleSources,
      external: options.external,
      env: options.env,
      resolve: options.resolve
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

  override async loadAsync(
    url: GLTSURL,
    onProgress?: GLTSProgressCallback
  ): Promise<GLTSScene> {
    const resolvedURL = this.#resolveURL(url);
    if (onProgress) {
      throw new GLTSError(
        "GLTSLoader does not support per-load progress callbacks; use LoadingManager.onProgress",
        { phase: "resolve", url: resolvedURL }
      );
    }
    return this.#load(resolvedURL);
  }

  /**
   * Runs one scene for a positive integer instance count. Without onMatrixUpdateAt, converts its meshes to
   * InstancedMesh and rejects cameras, lights, lines, points, sprites, LODs, skins, existing instances/batches,
   * morph targets, onFrame callbacks, nested GLTS scenes, or a hierarchy with no meshes.
   */
  async loadInstancesAsync(url: GLTSURL, count: number): Promise<GLTSInstances> {
    return this.#load(this.#resolveURL(url), count);
  }

  /** The build warmup's access to this loader; normal host loads never create a warmup session. */
  [resolveWarmup](urls: readonly GLTSURL[]): WarmupScripts {
    return {
      urls: urls.map((url) => this.#resolveURL(url)),
      execute: (run) => run.count === undefined
        ? this.#load(run.url, undefined, run.scope, run)
        : this.#load(run.url, run.count, run.scope, run),
    };
  }

  /**
   * Invalidates the source of the script at `url`, or of the helper at `url` and every helper and script
   * importing it, and reloads the scripts' undisposed nodes. Unloaded source is fetched on the next load.
   * A failed build preserves the live scene; cleanup errors can reject after a replacement is committed.
   */
  async reload(url: GLTSURL): Promise<void> {
    const resolvedURL = this.#resolveURL(url);
    this.#lifetime.signal.throwIfAborted();
    const invalidated = this.#linker.invalidate(resolvedURL);
    const results = await Promise.allSettled(invalidated.map((script) => this.#reloadScript(script)));
    const errors: unknown[] = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
    if (errors.length === 0) return;
    const primary = toGLTSError(errors[0], "Unable to reload GLTS script", { phase: "reload", url: resolvedURL });
    throw aggregate("Reloading the helper's scripts failed", primary, errors.slice(1));
  }

  dispose(): void {
    if (this.#lifetime.signal.aborted) return;
    this.#lifetime.abort(new GLTSError("Loader has been disposed", { phase: "dispose", url: "glts://loader" }));
    runAll("Loader disposal failed", [() => this.#nodes.disposeAll(), () => this.#linker.dispose()]);
  }

  /**
   * Loads the script at `requestedURL` as a scene, or with a `count` as that many instances, as one item of the
   * host's manager, or of the manager of the `scope` loading it.
   */
  #load(requestedURL: string, count?: undefined, scope?: LoadScope, nested?: NestedLoader): Promise<GLTSScene>;
  #load(requestedURL: string, count: number, scope?: LoadScope, nested?: NestedLoader): Promise<GLTSInstances>;
  #load(requestedURL: string, count?: number, scope?: LoadScope, nested?: NestedLoader): Promise<GLTSScene> {
    if (count !== undefined && (!Number.isSafeInteger(count) || count < 1)) {
      throw new RangeError("GLTS instance count must be a positive integer");
    }
    const request: LoadRequest = {
      requestedURL,
      matrices: Array.from({ length: count ?? 1 }, () => new THREE.Matrix4()),
      // Only the host's scene is the standalone script a preview shows.
      isPreview: this.#isPreview && count === undefined && !scope,
      instanced: count !== undefined,
      ancestors: scope?.chain ?? []
    };
    // trackItem starts the operation, and with it getScript, synchronously, so a reload requested from now on
    // finds this load pending and rebuilds its node if it read the source the reload invalidates.
    const manager = scope?.manager ?? this.manager;
    const failure: ItemFailure = { message: "Unable to load GLTS script", phase: "evaluate" };
    const loading = trackItem(manager, requestedURL, this.#lifetime.signal, failure, async () => {
      const script = await this.#linker.getScript(requestedURL);
      const execution = await this.#execute(script, request, nested);
      try {
        this.#lifetime.signal.throwIfAborted();
        return this.#nodes.add(execution, request);
      } catch (error) {
        cleanUpAndThrow(
          toGLTSError(error, `Unable to construct GLTS ${request.instanced ? "instances" : "scene"}`, {
            phase: "construct", url: requestedURL
          }),
          requestedURL,
          () => execution.dispose()
        );
      }
    }, (node) => node.dispose());
    const loads = this.#loads.get(requestedURL) ?? new Set();
    this.#loads.set(requestedURL, loads);
    loads.add(loading);
    const forget = (): void => {
      loads.delete(loading);
      if (loads.size === 0) this.#loads.delete(requestedURL);
    };
    void loading.then(forget, forget);
    return loading;
  }

  /** Runs `script` for `request` in a loading scope of its own, reporting to the loader's manager. */
  async #execute(script: Script, request: LoadRequest, loader: NestedLoader = this.#nested): Promise<Execution> {
    const signal = this.#lifetime.signal;
    signal.throwIfAborted();
    const dependencies = new Dependencies();
    dependencies.include(script.dependencies);
    const scope = new LoadScope({ script, request, host: this.manager, dependencies, loader, signal });
    const execution = new Execution({ script, request, scope, dependencies });
    await execution.run();
    return execution;
  }

  /**
   * After the reloads before it and the loads that may have read the invalidated source of the script at
   * `requestedURL`, rebuilds the nodes not yet from its current source.
   */
  #reloadScript(requestedURL: string): Promise<void> {
    const stale = [...this.#loads.get(requestedURL) ?? []];
    const reload = this.#lastReload.then(async () => {
      await Promise.allSettled(stale);
      // Taken before the fetch, so a node disposed while it runs fails the reload.
      const records = this.#nodes.records(requestedURL);
      if (records.length === 0) return;
      const failure: ItemFailure = { message: "Unable to reload GLTS script", phase: "reload" };
      await trackItem(this.manager, requestedURL, this.#lifetime.signal, failure, async () => {
        const script = await this.#linker.getScript(requestedURL);
        await this.#nodes.rebuild(
          records.filter((record) => record.execution.module !== script.module),
          requestedURL,
          (request) => this.#execute(script, request),
          // So the next load or reload fetches the source again.
          () => { this.#linker.invalidate(requestedURL); }
        );
      });
    });
    this.#lastReload = reload.then(() => undefined, () => undefined);
    return reload;
  }

  #resolveURL(url: GLTSURL): string {
    const input = url instanceof URL ? url.href : `${this.path}${url}`;
    return canonicalize(pageURL(this.manager.resolveURL(input)));
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

    return globalThis.fetch(input, requestInit);
  }
}
