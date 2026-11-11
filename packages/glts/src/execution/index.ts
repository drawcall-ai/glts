import type * as THREE from "three";

import type { Dependencies } from "../dependencies.js";
import { disposeRecursive } from "../dispose.js";
import { aggregate, cleanUpAndThrow, GLTSError, runAll, toGLTSError } from "../errors.js";
import { importNamespace, type Bindings } from "../imports.js";
import type { Script } from "../linker/index.js";
import type { LoadRequest } from "../nodes.js";
import type {
  GLTSSource,
  GLTSScriptLoader,
  GLTSDisposeCallback,
  GLTSFrameCallback,
  InstancedObject,
  GLTSScene,
} from "../types.js";
import { copyRootState, createRoot, type ScriptRoot } from "../root.js";
import { findTargets, type Targets } from "./targets.js";

function assertCallback(value: unknown, name: string): void {
  if (typeof value !== "function") {
    throw new TypeError(`${name} expects a function`);
  }
}

/** An execution's loading window: where its contextual `gltsLoader` and `loadingManager` come from. */
export interface ExecutionScope {
  readonly gltsLoader: GLTSScriptLoader;
  readonly manager: THREE.LoadingManager;
  /** The nested nodes the execution owns. */
  readonly nodes: readonly GLTSScene[];
  /** Waits for what the execution loads, then stops counting loads as its own; throws their failures. */
  settle(): Promise<void>;
  /** Closes and stops loading, returning the failures settle() has not thrown. */
  abort(reason: unknown): Promise<readonly unknown[]>;
  /** Disposes what the execution loaded through the scope. */
  dispose(): void;
}

export interface ExecutionOptions {
  readonly script: Pick<Script, "requestedURL" | "executionURL" | "module" | "env">;
  readonly request: Pick<LoadRequest, "isPreview" | "instances">;
  /** Disposed with the execution, first. */
  readonly scope: ExecutionScope;
  /** The files the execution uses, the script's included. */
  readonly dependencies: Dependencies;
}

/** One run of a script: its source, the root it builds, and the callbacks it registers. */
export class Execution {
  /** The script's own root, until this execution, replacing another on reload, adopts that one's node. */
  root: ScriptRoot;
  readonly url: string;
  /** The URL of the linked module it runs. */
  readonly module: string;
  readonly dependencies: Dependencies;
  readonly source: GLTSSource;
  readonly bindings: Bindings;
  readonly #onDispose: GLTSDisposeCallback[] = [];
  readonly #onFrame: GLTSFrameCallback[] = [];
  readonly #instanced: boolean;
  readonly #scope: ExecutionScope;
  readonly #env: Script["env"];
  #targets: Targets | undefined;
  #disposed = false;

  constructor(options: ExecutionOptions) {
    const { script, request, dependencies } = options;
    this.url = script.executionURL;
    this.module = script.module;
    this.#env = script.env;
    this.#instanced = request.instances !== undefined;
    this.#scope = options.scope;
    this.dependencies = dependencies;
    this.source = Object.freeze({
      url: script.executionURL,
      get packages() {
        return Object.freeze(dependencies.packages());
      },
      get moduleHashes() {
        return Object.freeze(dependencies.moduleHashes());
      },
      get runtimeModules() {
        return Object.freeze(dependencies.runtimeModules());
      },
      // A parent lists a nested script's own URLs; the script itself does not.
      get dependencyUrls() {
        return Object.freeze(dependencies.urls().filter((url) => url !== script.requestedURL && url !== script.executionURL));
      },
    });
    this.root = createRoot(this.source);
    const execution = this;
    this.bindings = Object.freeze({
      disposeRecursive,
      gltsLoader: options.scope.gltsLoader,
      loadingManager: options.scope.manager,
      onDispose: (callback: GLTSDisposeCallback) => {
        this.#assertUndisposed();
        assertCallback(callback, "onDispose");
        this.#onDispose.push(callback);
      },
      onFrame: (callback: GLTSFrameCallback) => {
        this.#assertUndisposed();
        assertCallback(callback, "onFrame");
        this.#onFrame.push(callback);
      },
      isPreview: request.isPreview,
      get scene() { return execution.root; },
    });
  }

  /**
   * Runs the script, waits for what it loads, and finds its targets when loaded as instances; on failure, aborts its
   * loads and disposes it.
   */
  async run(): Promise<void> {
    try {
      await this.#evaluate();
      await this.#scope.settle();
      if (this.#instanced) {
        this.#targets = findTargets(this.root, {
          nodes: new Set(this.#scope.nodes),
          frames: this.#onFrame.length > 0,
          url: this.url,
        });
      }
    } catch (error) {
      // The script's own failures are GLTSErrors already; anything else failed while building its scene.
      const primary = toGLTSError(error, "GLTS execution failed", { phase: "construct", url: this.url });
      const failure = aggregate("GLTS execution and its loads both failed", primary, await this.#scope.abort(primary));
      cleanUpAndThrow(failure, this.url, () => this.dispose());
    }
  }

  /** Evaluates the script's linked module, resolving once its top level finishes. */
  async #evaluate(): Promise<void> {
    try {
      // Module URLs are resolved when loaded, never by a bundler.
      const namespace: { default?: unknown } = await import(/* @vite-ignore */ /* webpackIgnore: true */ this.module);
      const entry = namespace.default;
      if (typeof entry !== "function") throw new Error("Compiled GLTS script has no entry point");
      const meta = { url: this.url, ...(this.#env === undefined ? {} : { env: { ...this.#env } }) };
      Object.setPrototypeOf(meta, null);
      await entry(importNamespace(this.bindings), meta);
    } catch (error) {
      throw toGLTSError(error, "Unable to execute GLTS script", { importChain: [this.url], phase: "evaluate", url: this.url });
    }
  }

  /** Takes over `node`, the root of the execution this one replaces, with this execution's root state and children. */
  adopt(node: ScriptRoot): void {
    copyRootState(node, this.root);
    for (const child of [...this.root.children]) {
      node.add(child);
    }
    this.root = node;
  }

  /** The instanced objects its node forwards its instancing data to, once it ran as instances. */
  get targets(): readonly InstancedObject[] {
    return this.#targets?.targets ?? [];
  }

  /** Disposes its scope, automatic instances, and callbacks, then empties the root. */
  dispose(): void {
    if (this.#disposed) {
      // A disposal callback disposing this node again still empties it.
      this.root.clear();
      return;
    }
    this.#disposed = true;
    const callbacks = this.#onDispose.splice(0).reverse();
    this.#onFrame.length = 0;
    runAll("GLTS execution disposal failed", [
      () => this.#scope.dispose(),
      () => this.#targets?.dispose(),
      ...callbacks,
      () => this.root.clear()
    ]);
  }

  update(delta: number): void {
    for (const callback of this.#onFrame) {
      callback(delta);
    }
  }

  #assertUndisposed(): void {
    if (this.#disposed) throw new GLTSError("GLTS execution has been disposed", { phase: "dispose", url: this.url });
  }
}
