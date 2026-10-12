import type * as THREE from "three";

import { GLTSError, runAll } from "../errors.js";
import type {
  GLTSDisposeCallback,
  GLTSFrameCallback,
  GLTSScene,
  GLTSMatrixUpdateCallback,
  GLTSScriptLoader,
} from "../types.js";
import { createScriptScene, type GLTSScriptScene } from "./state.js";
import { createAutoInstances, type AutoInstances } from "./instances.js";
import { NestedLoads } from "./nested.js";

export interface ScriptContext {
  readonly gltsLoader: GLTSScriptLoader;
  readonly instanceCount: number;
  readonly loadingManager: THREE.LoadingManager;
  readonly onDispose: (callback: GLTSDisposeCallback) => void;
  readonly onFrame: (callback: GLTSFrameCallback) => void;
  readonly onMatrixUpdateAt: (callback: GLTSMatrixUpdateCallback) => void;
  readonly isPreview: boolean;
  readonly scene: GLTSScriptScene;
  readonly bindScene: (bind: (scene: GLTSScene) => void) => void;
}

/** Disposes the managed nodes `owned` by an execution or found below `root`. */
export type DisposeNodes = (root: THREE.Object3D, owned: readonly GLTSScene[]) => void;

function assertCallback(value: unknown, name: string): void {
  if (typeof value !== "function") {
    throw new TypeError(`${name} expects a function`);
  }
}

export class Execution {
  readonly scene = createScriptScene();
  readonly nested: NestedLoads;
  readonly #disposals: GLTSDisposeCallback[] = [];
  readonly #frames: GLTSFrameCallback[] = [];
  readonly #matrixUpdates: GLTSMatrixUpdateCallback[] = [];
  readonly #matrices: readonly THREE.Matrix4[];
  readonly #disposeNodes: DisposeNodes;
  #automatic: AutoInstances | undefined;
  #bindScene: ((scene: GLTSScene) => void) | undefined;
  #disposed = false;

  constructor(
    matrices: readonly THREE.Matrix4[],
    urls: readonly string[],
    disposeNodes: DisposeNodes,
    parent?: Execution,
  ) {
    this.#matrices = matrices;
    this.#disposeNodes = disposeNodes;
    this.nested = new NestedLoads(urls, parent?.nested);
  }

  context(options: {
    readonly gltsLoader: GLTSScriptLoader;
    readonly loadingManager: THREE.LoadingManager;
    readonly isPreview: boolean;
  }): ScriptContext {
    return {
      bindScene: (bind) => {
        assertCallback(bind, "Internal scene binding");
        this.#bindScene = bind;
      },
      gltsLoader: options.gltsLoader,
      instanceCount: this.#matrices.length,
      loadingManager: options.loadingManager,
      onDispose: (callback) => {
        this.#assertActive();
        assertCallback(callback, "onDispose");
        this.#disposals.push(callback);
      },
      onFrame: (callback) => {
        this.#assertActive();
        assertCallback(callback, "onFrame");
        this.#frames.push(callback);
      },
      onMatrixUpdateAt: (callback) => {
        this.#assertActive();
        assertCallback(callback, "onMatrixUpdateAt");
        this.#matrixUpdates.push(callback);
        for (const [index, matrix] of this.#matrices.entries()) {
          callback(index, matrix.clone());
        }
      },
      isPreview: options.isPreview,
      scene: this.scene,
    };
  }

  bindScene(scene: GLTSScene): void {
    this.#bindScene?.(scene);
  }

  /** Instances scripts without onMatrixUpdateAt() automatically. */
  prepareInstances(url: string): void {
    if (this.#matrixUpdates.length > 0) return;
    if (this.#frames.length > 0) {
      throw new GLTSError(
        "Automatically instanced scripts cannot use onFrame(); implement native instancing with onMatrixUpdateAt()",
        { phase: "construct", url }
      );
    }
    if (this.nested.nodes.length > 0) {
      throw new GLTSError(
        "Automatically instanced scripts cannot contain nested GLTS scenes; implement native instancing with onMatrixUpdateAt()",
        { phase: "construct", url }
      );
    }
    this.#automatic = createAutoInstances(this.scene, this.#matrices, url);
  }

  /** Disposes nested nodes, automatic instances, and callbacks, then empties `root`. */
  dispose(root: THREE.Object3D = this.scene): void {
    if (this.#disposed) {
      // A disposal callback disposing this node again still empties it.
      root.clear();
      return;
    }
    this.#disposed = true;
    this.nested.close();
    const callbacks = this.#disposals.splice(0).reverse();
    this.#frames.length = 0;
    this.#matrixUpdates.length = 0;
    runAll("GLTS execution disposal failed", [
      () => this.#disposeNodes(root, this.nested.nodes),
      () => this.#automatic?.dispose(),
      ...callbacks,
      () => root.clear()
    ]);
  }

  setMatrixAt(index: number, matrix: THREE.Matrix4): void {
    if (this.#automatic) {
      this.#automatic.setMatrixAt(index, matrix);
      return;
    }
    for (const callback of this.#matrixUpdates) {
      callback(index, matrix.clone());
    }
  }

  update(delta: number): void {
    for (const callback of this.#frames) {
      callback(delta);
    }
  }

  #assertActive(): void {
    if (this.#disposed) throw new Error("GLTS execution has been disposed");
  }
}
