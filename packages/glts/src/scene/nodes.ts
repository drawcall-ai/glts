import * as THREE from "three";

import type { Execution } from "./execution.js";
import { GLTSError, runAll } from "../errors.js";
import type { GLTSInstances, GLTSScene } from "../types.js";
import type { GLTSScriptScene } from "./root.js";

/** What a load asks for; a reload repeats it. */
export interface LoadRequest {
  readonly url: string;
  readonly matrices: THREE.Matrix4[];
  readonly isPreview: boolean;
  readonly instances: boolean;
}

export interface NodeRecord extends LoadRequest {
  readonly node: GLTSScene;
  disposed: boolean;
  execution: Execution;
}

// defineProperties cannot change a static type, so these guards narrow the augmented scene.
function isManagedScene(value: unknown): value is GLTSScene {
  return (
    value instanceof THREE.Scene &&
    "rendering" in value &&
    typeof Reflect.get(value, "url") === "string" &&
    typeof Reflect.get(value, "dispose") === "function" &&
    typeof Reflect.get(value, "update") === "function"
  );
}

function isManagedInstances(value: unknown): value is GLTSInstances {
  return (
    isManagedScene(value) &&
    typeof Reflect.get(value, "count") === "number" &&
    typeof Reflect.get(value, "getMatrixAt") === "function" &&
    typeof Reflect.get(value, "setMatrixAt") === "function"
  );
}

/** Called once when their managed node is disposed. */
const disposeListeners = new WeakMap<THREE.Object3D, Set<() => void>>();

/** Calls `listener` when the managed `node` is disposed; returns a function that removes it. */
export function onNodeDispose(node: THREE.Object3D, listener: () => void): () => void {
  const listeners = disposeListeners.get(node) ?? new Set();
  disposeListeners.set(node, listeners);
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export class ManagedNodes {
  /** Undisposed nodes only. */
  readonly #records = new Map<THREE.Object3D, NodeRecord>();

  createScene(execution: Execution, request: LoadRequest): GLTSScene {
    const node = this.#defineSceneMethods(execution.scene, request.url);
    this.#records.set(node, { ...request, disposed: false, execution, node });
    return node;
  }

  createInstances(execution: Execution, request: LoadRequest): GLTSInstances {
    const scene = this.#defineSceneMethods(execution.scene, request.url);
    const matrixAt = (index: number): THREE.Matrix4 => {
      const matrix = this.#live(scene, request.url).matrices[index];
      if (!Number.isSafeInteger(index) || !matrix) {
        throw new RangeError(`GLTS instance index is out of range: ${index}`);
      }
      return matrix;
    };
    Object.defineProperties(scene, {
      count: { value: request.matrices.length },
      getMatrixAt: { value: (index: number, matrix: THREE.Matrix4) => matrix.copy(matrixAt(index)) },
      setMatrixAt: {
        value: (index: number, matrix: THREE.Matrix4) => {
          this.#live(scene, request.url).execution.setMatrixAt(index, matrixAt(index).copy(matrix));
          return scene;
        }
      }
    });
    if (!isManagedInstances(scene)) {
      throw new Error("Unable to create a managed GLTS instances node");
    }
    this.#records.set(scene, { ...request, disposed: false, execution, node: scene });
    return scene;
  }

  recordsForURL(url: string): NodeRecord[] {
    return [...this.#records.values()].filter((record) => record.url === url);
  }

  getRecord(node: GLTSScene): NodeRecord {
    return this.#live(node, node.url);
  }

  #update(node: THREE.Object3D, url: string, delta: number): void {
    const record = this.#live(node, url);
    if (!Number.isFinite(delta) || delta < 0) {
      throw new RangeError("GLTS update delta must be a non-negative finite number");
    }

    record.execution.update(delta);
    for (const descendant of this.#descendants(node)) {
      descendant.execution.update(delta);
    }
  }

  dispose(node: THREE.Object3D): void {
    const record = this.#records.get(node);
    if (!record) {
      return;
    }

    record.disposed = true;
    this.#records.delete(node);
    const listeners = [...disposeListeners.get(node) ?? []];
    disposeListeners.delete(node);
    runAll("GLTS node disposal failed", [() => record.execution.dispose(node), ...listeners]);
  }

  disposeNested(root: THREE.Object3D, owned: readonly GLTSScene[]): void {
    const nodes = new Set<THREE.Object3D>([
      ...owned,
      ...this.#descendants(root).map(({ node }) => node)
    ]);
    this.#disposeNodes([...nodes].reverse());
  }

  disposeAll(): void {
    this.#disposeNodes([...this.#records.keys()]);
  }

  #defineSceneMethods(scene: GLTSScriptScene, url: string): GLTSScene {
    Object.defineProperties(scene, {
      dispose: { value: () => this.dispose(scene) },
      update: { value: (delta: number) => this.#update(scene, url, delta) },
      url: { value: url }
    });
    if (!isManagedScene(scene)) {
      throw new Error("Unable to create a managed GLTS scene");
    }
    return scene;
  }

  #live(node: THREE.Object3D, url: string): NodeRecord {
    const record = this.#records.get(node);
    if (!record) {
      throw new GLTSError("GLTS node has been disposed", { phase: "dispose", url });
    }
    return record;
  }

  /** Disposes in order; a node an earlier disposal already disposed is skipped. */
  #disposeNodes(nodes: readonly THREE.Object3D[]): void {
    runAll("GLTS node disposal failed", nodes.map((node) => () => this.dispose(node)));
  }

  #descendants(root: THREE.Object3D): NodeRecord[] {
    const descendants: NodeRecord[] = [];
    root.traverse((object) => {
      const record = this.#records.get(object);
      if (record && object !== root) {
        descendants.push(record);
      }
    });
    return descendants;
  }
}
