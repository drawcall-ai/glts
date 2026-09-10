import * as THREE from "three";

import type { Execution } from "./execution.js";
import { GLTSError } from "../errors.js";
import type { AutoInstances } from "./instances.js";
import {
  attachInstanceMethods,
  createInstanceMatrixMethods,
  attachSceneMethods,
  type GLTSNode,
  type GLTSNodeKind
} from "./methods.js";
import type { GLTSInstances, GLTSScene } from "../types.js";
import { Revision } from "./revision.js";

export interface NodeRecord {
  readonly isPreview: boolean;
  readonly matrices: THREE.Matrix4[];
  readonly node: GLTSNode;
  readonly type: GLTSNodeKind;
  readonly url: string;
  disposed: boolean;
  revision: Revision;
}

export class ManagedNodes {
  readonly #records = new Map<THREE.Object3D, NodeRecord>();
  readonly #reload: (record: NodeRecord) => Promise<void>;

  constructor(reload: (record: NodeRecord) => Promise<void>) {
    this.#reload = reload;
  }

  createScene(
    prepared: Revision,
    url: string,
    isPreview: boolean,
    matrices: THREE.Matrix4[]
  ): GLTSScene {
    const root = prepared.execution.scene;
    return this.#create(prepared, url, isPreview, matrices, "scene", () =>
      attachSceneMethods(root, url, {
        physics: () => this.#records.get(root)?.revision.execution.physics ?? false,
        dispose: () => this.dispose(root),
        reload: () => this.#reload(this.getRecord(root)),
        update: (delta) => this.update(root, delta)
      })
    );
  }

  createInstances(
    prepared: Revision,
    url: string,
    isPreview: boolean,
    matrices: THREE.Matrix4[]
  ): GLTSInstances {
    const root = prepared.execution.scene;
    return this.#create(prepared, url, isPreview, matrices, "instances", () =>
      attachInstanceMethods(root, url, {
        count: matrices.length,
        physics: () => this.#records.get(root)?.revision.execution.physics ?? false,
        dispose: () => this.dispose(root),
        ...createInstanceMatrixMethods(() => this.getRecord(root)),
        reload: () => this.#reload(this.getRecord(root)),
        update: (delta) => this.update(root, delta)
      })
    );
  }

  recordsForURL(url: string): NodeRecord[] {
    return [...this.#records.values()].filter(
      (record) => !record.disposed && record.url === url
    );
  }

  getRecord(node: THREE.Object3D): NodeRecord {
    const record = this.#records.get(node);
    if (record && !record.disposed) {
      return record;
    }

    const value = Reflect.get(node, "url");
    throw new GLTSError("GLTS node has been disposed", {
      phase: "dispose",
      url: typeof value === "string" ? value : "glts://node"
    });
  }

  find(node: THREE.Object3D): NodeRecord | undefined {
    return this.#records.get(node);
  }

  update(node: THREE.Object3D, delta: number): void {
    const record = this.getRecord(node);
    if (!Number.isFinite(delta) || delta < 0) {
      throw new RangeError("GLTS update delta must be a non-negative finite number");
    }

    record.revision.execution.update(delta);
    for (const descendant of this.#descendants(node)) {
      descendant.revision.execution.update(delta);
    }
  }

  dispose(node: THREE.Object3D): void {
    const record = this.#records.get(node);
    if (!record || record.disposed) {
      return;
    }
    this.#disposeRecord(record);
  }

  createRevision(execution: Execution, automatic?: AutoInstances): Revision {
    return new Revision(execution, automatic, (root) => {
      const owned = execution.nested.nodes
        .map((node) => this.#records.get(node))
        .filter((record): record is NodeRecord => Boolean(record));
      const descendants = this.#descendants(root).filter((record) => !owned.includes(record));
      this.#disposeRecords([...owned, ...descendants].reverse());
    });
  }

  #disposeRecords(records: readonly NodeRecord[]): void {
    const errors: unknown[] = [];
    for (const record of records) {
      try {
        this.#disposeRecord(record);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, "GLTS node disposal failed");
    }
  }

  disposeAll(): void {
    this.#disposeRecords([...this.#records.values()]);
  }

  #disposeRecord(record: NodeRecord): void {
    if (record.disposed) {
      return;
    }

    record.disposed = true;
    this.#records.delete(record.node);
    record.revision.dispose(record.node);
  }

  #descendants(root: THREE.Object3D): NodeRecord[] {
    const descendants: NodeRecord[] = [];
    root.traverse((object) => {
      if (object === root) {
        return;
      }
      const record = this.#records.get(object);
      if (record && !record.disposed) {
        descendants.push(record);
      }
    });
    return descendants;
  }

  #create<T extends GLTSNode>(
    prepared: Revision,
    url: string,
    isPreview: boolean,
    matrices: THREE.Matrix4[],
    type: GLTSNodeKind,
    create: () => T
  ): T {
    let node: T;
    try {
      node = create();
    } catch (error) {
      try {
        prepared.dispose();
      } catch (cleanup) {
        throw new AggregateError([error, cleanup], "GLTS node creation and cleanup failed");
      }
      throw error;
    }

    this.#records.set(node, {
      disposed: false,
      revision: prepared,
      isPreview,
      matrices,
      node,
      type,
      url
    });
    return node;
  }
}
