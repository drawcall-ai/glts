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
    const node = attachSceneMethods(execution.scene, url, {
      dispose: () => this.dispose(node),
      reload: () => this.#reload(this.getRecord(node)),
      update: (delta) => this.update(node, delta)
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
    const node = attachInstanceMethods(execution.scene, url, {
      count: matrices.length,
      dispose: () => this.dispose(node),
      ...createInstanceMatrixMethods(() => this.getRecord(node)),
      reload: () => this.#reload(this.getRecord(node)),
      update: (delta) => this.update(node, delta)
    });
    this.#records.set(node, { disposed: false, instances: true, isPreview, matrices, node, execution, url });
    return node;
  }

  recordsForURL(url: string): NodeRecord[] {
    return [...this.#records.values()].filter((record) => record.url === url);
  }

  getRecord(node: GLTSScene): NodeRecord {
    const record = this.#records.get(node);
    if (record) {
      return record;
    }

    throw new GLTSError("GLTS node has been disposed", { phase: "dispose", url: node.url });
  }

  update(node: GLTSScene, delta: number): void {
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
    this.#disposeNodes([...nodes].reverse());
  }

  disposeAll(): void {
    this.#disposeNodes([...this.#records.keys()]);
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
