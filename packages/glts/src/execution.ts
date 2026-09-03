import * as THREE from "three";

import { GLTSError } from "./errors.js";
import type {
  GLTSDisposeCallback,
  GLTSFrameCallback,
  GLTSMatrixUpdateCallback,
  GLTSScriptLoader
} from "./types.js";

export interface ScriptContext {
  readonly gltsLoader: GLTSScriptLoader;
  readonly instanceCount: number;
  readonly loadingManager: THREE.LoadingManager;
  readonly onDispose: (callback: GLTSDisposeCallback) => void;
  readonly onFrame: (callback: GLTSFrameCallback) => void;
  readonly onMatrixUpdateAt: (callback: GLTSMatrixUpdateCallback) => void;
  readonly isPreview: boolean;
  readonly scene: THREE.Group;
  readonly bindScene: (bind: (scene: THREE.Group) => void) => void;
}

function assertCallback(value: unknown, name: string): void {
  if (typeof value !== "function") {
    throw new TypeError(`${name} expects a function`);
  }
}

export class Execution {
  readonly scene = new THREE.Group();
  readonly #ancestors: ReadonlySet<string>;
  readonly #disposals: GLTSDisposeCallback[] = [];
  readonly #frames: GLTSFrameCallback[] = [];
  readonly #matrixUpdates: GLTSMatrixUpdateCallback[] = [];
  readonly #matrices: readonly THREE.Matrix4[];
  readonly #nodes = new Set<THREE.Group>();
  readonly #pending = new Set<Promise<unknown>>();
  readonly #failures: unknown[] = [];
  #accepting = true;
  #bindScene: ((scene: THREE.Group) => void) | undefined;

  constructor(
    matrices: readonly THREE.Matrix4[],
    urls: readonly string[],
    parent?: Execution
  ) {
    this.#matrices = matrices;
    this.#ancestors = new Set([...(parent ? parent.#ancestors : []), ...urls]);
  }

  get animated(): boolean {
    return this.#frames.length > 0;
  }

  get nativeInstances(): boolean {
    return this.#matrixUpdates.length > 0;
  }

  get closed(): boolean {
    return !this.#accepting;
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
        assertCallback(callback, "onDispose");
        this.#disposals.push(callback);
      },
      onFrame: (callback) => {
        assertCallback(callback, "onFrame");
        this.#frames.push(callback);
      },
      onMatrixUpdateAt: (callback) => {
        assertCallback(callback, "onMatrixUpdateAt");
        this.#matrixUpdates.push(callback);
        for (const [index, matrix] of this.#matrices.entries()) {
          callback(index, matrix.clone());
        }
      },
      isPreview: options.isPreview,
      scene: this.scene
    };
  }

  bindScene(scene: THREE.Group): void {
    this.#bindScene?.(scene);
  }

  assertCanLoad(url: string): void {
    if (this.#ancestors.has(url)) {
      throw new GLTSError("Cyclic nested GLTS load", {
        importChain: [...this.#ancestors, url],
        phase: "resolve",
        url
      });
    }

    if (!this.#accepting) {
      throw new GLTSError("The contextual gltsLoader is no longer active", {
        phase: "resolve",
        url
      });
    }
  }

  own(node: THREE.Group): void {
    if (!this.#accepting) {
      throw new GLTSError("Nested GLTS load completed after its parent closed", {
        phase: "dispose",
        url: this.#nodeURL(node)
      });
    }
    this.#nodes.add(node);
  }

  ownedNodes(): readonly THREE.Group[] {
    return [...this.#nodes];
  }

  async settleNested(): Promise<void> {
    while (this.#pending.size > 0) {
      await Promise.allSettled([...this.#pending]);
    }

    this.#accepting = false;
    if (this.#failures.length > 0) {
      throw new AggregateError(this.#failures, "Nested GLTS operation failed");
    }

    const attached = new Set<THREE.Object3D>();
    this.scene.traverse((object) => attached.add(object));
    const orphan = [...this.#nodes].find((node) => !attached.has(node));
    if (orphan) {
      throw new GLTSError("Nested GLTS scenes must be added to scene", {
        phase: "construct",
        url: this.#nodeURL(orphan)
      });
    }
  }

  track<T>(promise: Promise<T>): Promise<T> {
    this.#pending.add(promise);
    void promise.then(
      () => this.#pending.delete(promise),
      (error: unknown) => {
        this.#pending.delete(promise);
        this.#failures.push(error);
      }
    );
    return promise;
  }

  dispose(): void {
    this.#accepting = false;
    const errors: unknown[] = [];
    for (const callback of [...this.#disposals].reverse()) {
      try {
        callback();
      } catch (error) {
        errors.push(error);
      }
    }

    this.#disposals.length = 0;
    this.#frames.length = 0;
    this.#matrixUpdates.length = 0;

    if (errors.length > 0) {
      throw new AggregateError(errors, "GLTS disposal callbacks failed");
    }
  }

  setMatrixAt(index: number, matrix: THREE.Matrix4): void {
    for (const callback of this.#matrixUpdates) {
      callback(index, matrix.clone());
    }
  }

  update(delta: number): void {
    for (const callback of this.#frames) {
      callback(delta);
    }
  }

  #nodeURL(node: THREE.Group): string {
    const url = Reflect.get(node, "url");
    return typeof url === "string" ? url : "glts://nested-node";
  }
}
