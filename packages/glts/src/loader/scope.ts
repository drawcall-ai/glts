import type * as THREE from "three";

import type { Dependencies } from "../dependencies.js";
import { aggregate, GLTSError, runAll, toGLTSError } from "../errors.js";
import type { ExecutionScope } from "../execution/index.js";
import type { Script } from "../linker/index.js";
import { nodeDependencies, onNodeDispose, type LoadRequest } from "../node.js";
import type { GLTSInstances, GLTSModuleSource, GLTSScene, GLTSURL } from "../types.js";
import { canonicalize } from "../urls.js";
import { Resources, type ScopePhase } from "./resources.js";
import { ScriptLoader } from "./script.js";

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
  /** The loader's moduleSources, which its contextual gltsLoader publishes too. */
  readonly moduleSources: Readonly<Record<string, GLTSModuleSource>>;
  /** The loader's lifetime, whose abort aborts the scope. */
  readonly signal: AbortSignal;
}

/**
 * One execution's loading window: its contextual `gltsLoader` and `loadingManager`, loading while the script
 * builds, which settles once its nested loads and then its resources end, or aborts. It owns the nodes of its
 * nested loads, attached or not. Once settled, both still load until disposed, outside the execution's load, for
 * content a library loads on demand: their items report to the host's manager only.
 */
export class LoadScope implements ExecutionScope {
  readonly gltsLoader: ScriptLoader;
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
  /** The URLs of the nested loads started before the scope settled, which fail as items of its manager too. */
  readonly #nestedURLs = new Set<string>();
  #phase: ScopePhase = "loading";
  /** The reason the scope aborted with, once aborted. */
  #abortReason: unknown;

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
      phase: () => this.#phase,
    });
    const { loader } = options;
    this.gltsLoader = new ScriptLoader(
      this.#resources.manager,
      options.moduleSources,
      (url) => this.#load(url, (resolved) => loader.loadAsync(resolved, this)),
      (url, count) => this.#load(url, (resolved) => loader.loadInstancesAsync(resolved, count, this)),
    );
  }

  /** The contextual loadingManager. */
  get manager(): THREE.LoadingManager {
    return this.#resources.manager;
  }

  /** The nodes of the nested loads that succeeded, until they are disposed. */
  get nodes(): readonly GLTSScene[] {
    return [...this.#nodes];
  }

  /**
   * Waits for the nested loads and the resources, including ones started meanwhile, and throws the nested loads'
   * failures, the first with its own phase, URL, and import chain, then the resources'.
   */
  async settle(): Promise<void> {
    for (;;) {
      await this.#waitForLoads();
      if (this.#phase === "aborted") throw this.#abortReason;
      const failures = this.#nestedFailures.splice(0);
      if (failures.length > 0) {
        const primary = toGLTSError(failures[0], "Nested GLTS load failed", { phase: "evaluate", url: this.#url });
        throw aggregate("Nested GLTS load failed", primary, failures.slice(1));
      }
      const loads = this.#loads.length;
      await this.#resources.idle();
      if (this.#loads.length === loads && !this.#resources.loading) break;
    }
    this.#phase = "settled";
    this.#signal.removeEventListener("abort", this.#onAbort);
    this.#resources.assertLoaded();
  }

  /**
   * Closes both loaders, aborts the resources, and rejects settle(); then waits for the nested loads in flight,
   * which cannot be stopped, returning the failures settle() has not thrown: the nested loads', then the resources'.
   */
  async abort(reason: unknown): Promise<readonly unknown[]> {
    // Taken before stopping, so the resources the stop aborts are not listed; once settled, settle() threw them.
    // Failed nested loads are listed as the nested failures they also are.
    const resources = this.#phase === "loading" ? this.#resources.failure(this.#nestedURLs) : undefined;
    this.#stop(reason);
    await this.#waitForLoads();
    return [...this.#nestedFailures.splice(0), ...(resources ? [resources] : [])];
  }

  /**
   * Aborts the resources still loading, disposes the nodes of the nested loads, the last loaded first, and refuses
   * further loads.
   */
  dispose(): void {
    this.#phase = "disposed";
    this.#resources.abort(new GLTSError("The script was disposed", { phase: "dispose", url: this.#url }));
    runAll("Nested GLTS node disposal failed", [...this.#nodes].reverse().map((node) => () => node.dispose()));
  }

  #stop(reason: unknown): void {
    if (this.#phase !== "loading") return;
    this.#phase = "aborted";
    this.#abortReason = reason;
    this.#signal.removeEventListener("abort", this.#onAbort);
    this.#resources.abort(reason);
  }

  async #waitForLoads(): Promise<void> {
    for (const load of this.#loads) await load;
  }

  /**
   * Starts the nested load of `url` with `load`, owning its node; a load started before the scope settled is part of
   * the execution's load and dependencies.
   */
  #load<T extends GLTSScene>(url: GLTSURL, load: (url: string) => Promise<T>): Promise<T> {
    const resolved = this.#resolve(url);
    const phase = this.#phase;
    if (phase === "aborted" || phase === "disposed") {
      throw new GLTSError("The contextual gltsLoader is no longer open", { phase: "dispose", url: this.#url });
    }
    const late = phase === "settled";
    if (!late) this.#nestedURLs.add(resolved);
    const loading = load(resolved).then((node) => {
      if (this.#phase === "disposed") {
        node.dispose();
        throw new GLTSError("The script that loaded this scene was disposed", { phase: "dispose", url: resolved });
      }
      this.#nodes.add(node);
      // A node the script disposes, such as a library's temporary build input, is no longer the scope's to dispose.
      onNodeDispose(node, () => this.#nodes.delete(node));
      if (!late) this.#dependencies.include(nodeDependencies(node));
      return node;
    });
    if (!late) this.#loads.push(loading.then(() => undefined, (error: unknown) => { this.#nestedFailures.push(error); }));
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
}
