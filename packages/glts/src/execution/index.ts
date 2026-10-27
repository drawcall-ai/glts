import type * as THREE from "three";

import { runWithExecution } from "../context.js";
import type { Dependencies } from "../dependencies.js";
import { aggregate, cleanUpAndThrow, GLTSError, runAll, toGLTSError } from "../errors.js";
import { importNamespace } from "../imports.js";
import type { Script } from "../linker/index.js";
import type { LoadRequest } from "../node.js";
import type {
  GLTSContext,
  GLTSContextLoader,
  GLTSDisposeCallback,
  GLTSFrameCallback,
  GLTSMatrixUpdateCallback,
  GLTSScene,
} from "../types.js";
import { copyRootState, createRoot, type ScriptRoot } from "../root.js";
import { createAutoInstances, type AutoInstances } from "./auto-instances.js";

function assertCallback(value: unknown, name: string): void {
  if (typeof value !== "function") {
    throw new TypeError(`${name} expects a function`);
  }
}

/** An execution's loading window: where its contextual `gltsLoader` and `loadingManager` come from. */
export interface ExecutionScope {
  readonly gltsLoader: GLTSContextLoader;
  readonly manager: THREE.LoadingManager;
  /** The nested nodes the execution owns. */
  readonly nodes: readonly GLTSScene[];
  /** Waits for what the execution loads, which must end attached to `root`, then closes; throws their failures. */
  settle(root: THREE.Object3D): Promise<void>;
  /** Closes and stops loading, returning the failures settle() has not thrown. */
  abort(reason: unknown): Promise<readonly unknown[]>;
  /** Disposes what the execution loaded through the scope. */
  dispose(): void;
}

export interface ExecutionOptions {
  readonly script: Pick<Script, "requestedURL" | "url" | "module">;
  readonly request: Pick<LoadRequest, "matrices" | "isPreview" | "instanced">;
  /** Disposed with the execution, first. */
  readonly scope: ExecutionScope;
  /** The files the execution uses, the script's included. */
  readonly dependencies: Dependencies;
}

/** One run of a script: its context, the root it builds, and the callbacks it registers. */
export class Execution {
  /** The script's own root, until this execution, replacing another on reload, adopts that one's node. */
  root = createRoot();
  readonly url: string;
  /** The URL of the linked module it runs. */
  readonly module: string;
  readonly dependencies: Dependencies;
  readonly context: GLTSContext;
  readonly #onDispose: GLTSDisposeCallback[] = [];
  readonly #onFrame: GLTSFrameCallback[] = [];
  readonly #onMatrixUpdateAt: GLTSMatrixUpdateCallback[] = [];
  readonly #matrices: readonly THREE.Matrix4[];
  readonly #instanced: boolean;
  readonly #scope: ExecutionScope;
  #autoInstances: AutoInstances | undefined;
  #disposed = false;

  constructor(options: ExecutionOptions) {
    const { script, request } = options;
    this.url = script.url;
    this.module = script.module;
    this.#matrices = request.matrices;
    this.#instanced = request.instanced;
    this.#scope = options.scope;
    this.dependencies = options.dependencies;
    const execution = this;
    this.context = Object.freeze({
      url: script.url,
      // A parent lists a nested script's own URLs; the script itself does not.
      get dependencies() {
        return Object.freeze(execution.dependencies.snapshot().filter((url) => url !== script.requestedURL && url !== script.url));
      },
      gltsLoader: options.scope.gltsLoader,
      instanceCount: this.#matrices.length,
      loadingManager: options.scope.manager,
      onDispose: (callback: GLTSDisposeCallback) => {
        this.#assertUndisposed();
        assertCallback(callback, "onDispose");
        this.#onDispose.push(() => runWithExecution(this, callback));
      },
      onFrame: (callback: GLTSFrameCallback) => {
        this.#assertUndisposed();
        assertCallback(callback, "onFrame");
        this.#onFrame.push((delta) => runWithExecution(this, () => callback(delta)));
      },
      onMatrixUpdateAt: (callback: GLTSMatrixUpdateCallback) => {
        this.#assertUndisposed();
        assertCallback(callback, "onMatrixUpdateAt");
        const update: GLTSMatrixUpdateCallback = (index, matrix) =>
          runWithExecution(this, () => callback(index, matrix));
        this.#onMatrixUpdateAt.push(update);
        for (const [index, matrix] of this.#matrices.entries()) {
          update(index, matrix.clone());
        }
      },
      isPreview: request.isPreview,
      get scene() { return execution.root; },
    });
  }

  /**
   * Runs the script, waits for what it loads, and instances it automatically when the request is instanced
   * and the script does not instance itself; on failure, aborts its loads and disposes it.
   */
  async run(): Promise<void> {
    try {
      await this.#evaluate();
      await this.#scope.settle(this.root);
      if (this.#instanced && this.#onMatrixUpdateAt.length === 0) this.#autoInstance();
    } catch (error) {
      // The script's own failures are GLTSErrors already; anything else failed while building its scene.
      const primary = toGLTSError(error, "GLTS execution failed", { phase: "construct", url: this.url });
      const failure = aggregate("GLTS execution and nested load both failed", primary, await this.#scope.abort(primary));
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
      await runWithExecution(this, () => entry(importNamespace(this.context)));
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

  /** Instances a script that does not instance itself, which needs it to have no frame callbacks or nested nodes. */
  #autoInstance(): void {
    if (this.#onFrame.length > 0) {
      throw new GLTSError(
        "Automatically instanced scripts cannot use onFrame(); implement native instancing with onMatrixUpdateAt()",
        { phase: "construct", url: this.url }
      );
    }
    if (this.#scope.nodes.length > 0) {
      throw new GLTSError(
        "Automatically instanced scripts cannot contain nested GLTS scenes; implement native instancing with onMatrixUpdateAt()",
        { phase: "construct", url: this.url }
      );
    }
    this.#autoInstances = createAutoInstances(this.root, this.#matrices, this.url);
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
    this.#onMatrixUpdateAt.length = 0;
    runAll("GLTS execution disposal failed", [
      () => this.#scope.dispose(),
      () => this.#autoInstances?.dispose(),
      ...callbacks,
      () => this.root.clear()
    ]);
  }

  setMatrixAt(index: number, matrix: THREE.Matrix4): void {
    if (this.#autoInstances) {
      this.#autoInstances.setMatrixAt(index, matrix);
      return;
    }
    for (const callback of this.#onMatrixUpdateAt) {
      callback(index, matrix.clone());
    }
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
