import type * as THREE from "three";

import type { Dependencies } from "../dependencies.js";
import { aggregate, GLTSError, runAll, toGLTSError } from "../errors.js";
import type { ExecutionScope } from "../execution/index.js";
import type { Script } from "../linker/index.js";
import { nodeDependencies, type LoadRequest } from "../node.js";
import type { GLTSScriptLoader, GLTSInstances, GLTSScene, GLTSURL } from "../types.js";
import { canonicalize } from "../urls.js";
import { Resources } from "./resources.js";

/** Loads the script at a resolved URL for `scope`, as one item of its manager. */
export interface NestedLoader {
  loadAsync(url: string, scope: LoadScope): Promise<GLTSScene>;
  loadInstancesAsync(url: string, count: number, scope: LoadScope): Promise<GLTSInstances>;
}

export interface LoadScopeOptions {
  /** The host's manager, which gets the scope's items and resolves its URLs. */
  readonly host: THREE.LoadingManager;
  /** The script the execution runs, whose URL nested URLs resolve against. */
  readonly script: Pick<Script, "requestedURL" | "executionURL">;
  /** The load the execution runs for. */
  readonly request: Pick<LoadRequest, "ancestors">;
  /** The execution's dependencies, which get its resources and nested nodes. */
  readonly dependencies: Dependencies;
  readonly loader: NestedLoader;
  /** The loader's lifetime, whose abort aborts the scope. */
  readonly signal: AbortSignal;
}

/**
 * One execution's loading window: its contextual `gltsLoader` and `loadingManager`, open while the script
 * builds, which settles once its nested loads and then its resources end, or aborts. It owns the nodes of its
 * nested loads.
 */
export class LoadScope implements ExecutionScope {
  readonly gltsLoader: GLTSScriptLoader;
  /**
   * The import path of the scope's nested loads, which they must not repeat: the URLs of the scripts that loaded
   * the execution and its own requested and fetched URLs.
   */
  readonly chain: readonly string[];
  readonly #host: THREE.LoadingManager;
  readonly #url: string;
  readonly #dependencies: Dependencies;
  readonly #signal: AbortSignal;
  readonly #resources: Resources;
  readonly #onAbort = (): void => this.#stop(this.#signal.reason);
  readonly #nodes = new Set<GLTSScene>();
  /** Every nested load, settled with its failure collected. */
  readonly #loads: Promise<void>[] = [];
  /**
   * The failures of nested loads not yet reported. settle() throws those it finds once the loads settle,
   * unless the scope aborted meanwhile; abort() returns the rest.
   */
  readonly #nestedFailures: unknown[] = [];
  /** What may still start: everything until the nested loads settle, then resources until the scope ends. */
  #open: "all" | "resources" | "none" = "all";
  #abort: { readonly reason: unknown } | undefined;

  constructor(options: LoadScopeOptions) {
    this.#host = options.host;
    const { script, request } = options;
    this.#url = script.executionURL;
    this.chain = [...new Set([...request.ancestors, script.requestedURL, script.executionURL])];
    this.#dependencies = options.dependencies;
    this.#signal = options.signal;
    this.#signal.addEventListener("abort", this.#onAbort);
    this.#resources = new Resources({
      host: options.host,
      url: script.executionURL,
      dependencies: options.dependencies,
      assertOpen: () => this.#assertOpen("resources"),
    });
    const { loader } = options;
    this.gltsLoader = {
      loadAsync: async (url) => this.#load(url, (resolved) => loader.loadAsync(resolved, this)),
      loadInstancesAsync: async (url, count) =>
        this.#load(url, (resolved) => loader.loadInstancesAsync(resolved, count, this)),
    };
  }

  /** The contextual loadingManager. */
  get manager(): THREE.LoadingManager {
    return this.#resources.manager;
  }

  /** The nodes of the nested loads that succeeded. */
  get nodes(): readonly GLTSScene[] {
    return [...this.#nodes];
  }

  /**
   * Waits for the nested loads, including ones started meanwhile, and throws their failures, the first with its own
   * phase, URL, and import chain; then requires their
   * nodes below `root`, waits for the resources, and throws theirs.
   */
  async settle(root: THREE.Object3D): Promise<void> {
    await this.#waitForLoads();
    if (this.#abort) throw this.#abort.reason;
    const failures = this.#nestedFailures.splice(0);
    if (failures.length > 0) {
      const primary = toGLTSError(failures[0], "Nested GLTS load failed", { phase: "evaluate", url: this.#url });
      throw aggregate("Nested GLTS load failed", primary, failures.slice(1));
    }
    this.#assertAttached(root);
    await this.#resources.idle();
    this.#end();
    this.#resources.assertLoaded();
  }

  /**
   * Closes both loaders, aborts the resources, and rejects settle(); then waits for the nested loads in flight,
   * which cannot be stopped, returning the failures settle() has not thrown.
   */
  async abort(reason: unknown): Promise<readonly unknown[]> {
    this.#stop(reason);
    await this.#waitForLoads();
    return this.#nestedFailures.splice(0);
  }

  /** Disposes the nodes of the nested loads, the last loaded first. */
  dispose(): void {
    runAll("Nested GLTS node disposal failed", [...this.#nodes].reverse().map((node) => () => node.dispose()));
  }

  #stop(reason: unknown): void {
    if (this.#open === "none") return;
    this.#end();
    this.#abort = { reason };
    this.#resources.abort(reason);
  }

  #end(): void {
    this.#open = "none";
    this.#signal.removeEventListener("abort", this.#onAbort);
  }

  async #waitForLoads(): Promise<void> {
    for (const load of this.#loads) await load;
    if (this.#open === "all") this.#open = "resources";
  }

  /** Starts the nested load of `url` with `load`, tracking it and owning its node. */
  #load<T extends GLTSScene>(url: GLTSURL, load: (url: string) => Promise<T>): Promise<T> {
    const resolved = this.#resolve(url);
    this.#assertOpen("loads");
    const loading = load(resolved).then((node) => {
      this.#nodes.add(node);
      this.#dependencies.include(nodeDependencies(node));
      return node;
    });
    this.#loads.push(loading.then(() => undefined, (error: unknown) => { this.#nestedFailures.push(error); }));
    return loading;
  }

  /** Resolves a nested URL against the script, rejecting a script already loading it. */
  #resolve(url: GLTSURL): string {
    const resolved = canonicalize(new URL(this.#host.resolveURL(String(url)), this.#url));
    if (this.chain.includes(resolved)) {
      throw new GLTSError("Cyclic nested GLTS load", {
        importChain: [...this.chain, resolved],
        phase: "resolve",
        url: resolved,
      });
    }
    return resolved;
  }

  #assertAttached(root: THREE.Object3D): void {
    const attached = new Set<THREE.Object3D>();
    root.traverse((object) => attached.add(object));
    const orphan = [...this.#nodes].find((node) => !attached.has(node));
    if (orphan) {
      throw new GLTSError("Nested GLTS scenes must be added to scene", { phase: "construct", url: orphan.url });
    }
  }

  /** Throws unless nested `loads` may still start, or `resources` may. */
  #assertOpen(kind: "loads" | "resources"): void {
    if (this.#open === "all" || (kind === "resources" && this.#open === "resources")) return;
    const name = kind === "loads" ? "gltsLoader" : "loadingManager";
    throw new GLTSError(`The contextual ${name} is no longer open`, { phase: "dispose", url: this.#url });
  }
}
