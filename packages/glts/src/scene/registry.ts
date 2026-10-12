import type * as THREE from "three";

import type { Execution } from "./execution.js";
import { GLTSError, runAll } from "../errors.js";
import {
  attachInstanceMethods,
  createInstanceMatrixMethods,
  attachSceneMethods
} from "./methods.js";
import type { GLTSInstances, GLTSScene } from "../types.js";

export interface NodeRecord {
  readonly instances: boolean;
  readonly isPreview: boolean;
  readonly matrices: THREE.Matrix4[];
  readonly node: GLTSScene;
  readonly url: string;
  disposed: boolean;
  execution: Execution;
}

export class ManagedNodes {
  /** Undisposed nodes only. */
  readonly #records = new Map<THREE.Object3D, NodeRecord>();
  readonly #reload: (record: NodeRecord) => Promise<void>;

  constructor(reload: (record: NodeRecord) => Promise<void>) {
    this.#reload = reload;
  }

  createScene(
    execution: Execution,
    url: string,
    isPreview: boolean,
    matrices: THREE.Matrix4[]
  ): GLTSScene {
    const root = execution.scene;
    const node = attachSceneMethods(root, url, {
      dispose: () => this.dispose(root),
      reload: () => this.#reload(this.getRecord(root)),
      update: (delta) => this.update(root, delta)
    });
    this.#records.set(node, { disposed: false, instances: false, isPreview, matrices, node, execution, url });
    return node;
  }

  createInstances(
    execution: Execution,
    url: string,
    isPreview: boolean,
    matrices: THREE.Matrix4[]
  ): GLTSInstances {
    const root = execution.scene;
    const node = attachInstanceMethods(root, url, {
      count: matrices.length,
      dispose: () => this.dispose(root),
      ...createInstanceMatrixMethods(() => this.getRecord(root)),
      reload: () => this.#reload(this.getRecord(root)),
      update: (delta) => this.update(root, delta)
    });
    this.#records.set(node, { disposed: false, instances: true, isPreview, matrices, node, execution, url });
    return node;
  }

  recordsForURL(url: string): NodeRecord[] {
    return [...this.#records.values()].filter((record) => record.url === url);
  }

  getRecord(node: THREE.Object3D): NodeRecord {
    const record = this.#records.get(node);
    if (record) {
      return record;
    }

    const value = Reflect.get(node, "url");
    throw new GLTSError("GLTS node has been disposed", {
      phase: "dispose",
      url: typeof value === "string" ? value : "glts://node"
    });
  }

  update(node: THREE.Object3D, delta: number): void {
    const record = this.getRecord(node);
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
    record.execution.dispose(node);
  }

  disposeNested(root: THREE.Object3D, owned: readonly GLTSScene[]): void {
    const nodes = new Set<THREE.Object3D>([
      ...owned,
      ...this.#descendants(root).map(({ node }) => node)
    ]);
    this.#disposeAll([...nodes].reverse());
  }

  disposeAll(): void {
    this.#disposeAll([...this.#records.keys()]);
  }

  /** Disposes in order; a node an earlier disposal already disposed is skipped. */
  #disposeAll(nodes: readonly THREE.Object3D[]): void {
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
