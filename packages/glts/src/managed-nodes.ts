import * as THREE from "three";

import { Execution } from "./execution.js";
import { GLTSError } from "./errors.js";
import type { AutoInstances } from "./instances.js";
import {
  createInstancesNode,
  createSceneNode,
  type GLTSNode,
  type GLTSNodeKind
} from "./node.js";
import type { GLTSInstances, GLTSScene } from "./types.js";
import type { GLTSScriptScene } from "./rendering.js";

export interface PreparedExecution {
  readonly automatic: AutoInstances | undefined;
  readonly execution: Execution;
}

export interface NodeRecord {
  readonly isPreview: boolean;
  readonly matrices: THREE.Matrix4[];
  readonly node: GLTSNode;
  readonly type: GLTSNodeKind;
  readonly url: string;
  automatic: AutoInstances | undefined;
  disposed: boolean;
  execution: Execution;
}

function copyRootState(target: GLTSScene, source: GLTSScriptScene): void {
  // The revision owns root metadata and render state; the caller owns its transform.
  target.name = source.name;
  target.layers.mask = source.layers.mask;
  target.visible = source.visible;
  target.castShadow = source.castShadow;
  target.receiveShadow = source.receiveShadow;
  target.frustumCulled = source.frustumCulled;
  target.renderOrder = source.renderOrder;
  target.animations = source.animations.slice();
  target.userData = source.userData;
  target.defaultCamera = source.defaultCamera;
  target.background = source.background;
  target.backgroundBlurriness = source.backgroundBlurriness;
  target.backgroundIntensity = source.backgroundIntensity;
  target.backgroundRotation.copy(source.backgroundRotation);
  target.environment = source.environment;
  target.environmentIntensity = source.environmentIntensity;
  target.environmentRotation.copy(source.environmentRotation);
  target.fog = source.fog;
  target.overrideMaterial = source.overrideMaterial;
  Object.assign(target.rendering, source.rendering, {
    effects: source.rendering.effects.slice()
  });
}

export class ManagedNodes {
  readonly #records = new Map<THREE.Object3D, NodeRecord>();
  readonly #reload: (record: NodeRecord) => Promise<void>;

  constructor(reload: (record: NodeRecord) => Promise<void>) {
    this.#reload = reload;
  }

  createScene(
    prepared: PreparedExecution,
    url: string,
    isPreview: boolean,
    matrices: THREE.Matrix4[]
  ): GLTSScene {
    const root = prepared.execution.scene;
    return this.#create(prepared, url, isPreview, matrices, "scene", () =>
      createSceneNode(root, url, {
        dispose: () => this.dispose(root),
        reload: () => this.#reload(this.record(root)),
        update: (delta) => this.update(root, delta)
      })
    );
  }

  createInstances(
    prepared: PreparedExecution,
    url: string,
    isPreview: boolean,
    matrices: THREE.Matrix4[]
  ): GLTSInstances {
    const root = prepared.execution.scene;
    return this.#create(prepared, url, isPreview, matrices, "instances", () =>
      createInstancesNode(root, url, {
        count: matrices.length,
        dispose: () => this.dispose(root),
        getMatrixAt: (index, matrix) => this.#getMatrixAt(root, index, matrix),
        reload: () => this.#reload(this.record(root)),
        setMatrixAt: (index, matrix) => this.#setMatrixAt(root, index, matrix),
        update: (delta) => this.update(root, delta)
      })
    );
  }

  records(url: string): NodeRecord[] {
    return [...this.#records.values()].filter(
      (record) => !record.disposed && record.url === url
    );
  }

  record(node: THREE.Object3D): NodeRecord {
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

  replace(record: NodeRecord, prepared: PreparedExecution): void {
    const oldChildren = new THREE.Group();
    while (record.node.children.length > 0) {
      const child = record.node.children[0];
      if (!child) {
        break;
      }
      oldChildren.add(child);
    }

    let disposalError: unknown;
    try {
      this.disposeExecution(record.execution, oldChildren, record.automatic);
    } catch (error) {
      disposalError = error;
    }

    record.automatic = prepared.automatic;
    record.execution = prepared.execution;
    copyRootState(record.node, prepared.execution.scene);
    while (prepared.execution.scene.children.length > 0) {
      const child = prepared.execution.scene.children[0];
      if (!child) {
        break;
      }
      record.node.add(child);
    }
    prepared.execution.bindScene(record.node);

    if (disposalError) {
      throw disposalError;
    }
  }

  update(node: THREE.Object3D, delta: number): void {
    const record = this.record(node);
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
    if (!record || record.disposed) {
      return;
    }
    this.#disposeRecord(record);
  }

  disposeExecution(
    execution: Execution,
    root: THREE.Object3D,
    automatic?: AutoInstances
  ): void {
    const errors: unknown[] = [];
    const owned = execution.ownedNodes()
      .map((node) => this.#records.get(node))
      .filter((record): record is NodeRecord => Boolean(record));
    const descendants = this.#descendants(root)
      .filter((record) => !owned.includes(record));
    for (const record of [...owned, ...descendants].reverse()) {
      try {
        this.#disposeRecord(record);
      } catch (error) {
        errors.push(error);
      }
    }

    try {
      automatic?.dispose();
    } catch (error) {
      errors.push(error);
    }

    try {
      execution.dispose();
    } catch (error) {
      errors.push(error);
    }
    root.clear();

    if (errors.length > 0) {
      throw new AggregateError(errors, "GLTS execution disposal failed");
    }
  }

  disposeAll(): void {
    const errors: unknown[] = [];
    for (const record of [...this.#records.values()]) {
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

  #getMatrixAt(
    node: THREE.Object3D,
    index: number,
    matrix: THREE.Matrix4
  ): THREE.Matrix4 {
    return matrix.copy(this.#matrix(this.record(node), index));
  }

  #setMatrixAt(node: THREE.Object3D, index: number, matrix: THREE.Matrix4): void {
    const record = this.record(node);
    const target = this.#matrix(record, index);
    target.copy(matrix);
    if (record.execution.nativeInstances) {
      record.execution.setMatrixAt(index, target);
    } else {
      record.automatic?.setMatrixAt(index, target);
    }
  }

  #matrix(record: NodeRecord, index: number): THREE.Matrix4 {
    if (!Number.isSafeInteger(index)) {
      throw new RangeError(`GLTS instance index is out of range: ${index}`);
    }

    const matrix = record.matrices[index];
    if (!matrix) {
      throw new RangeError(`GLTS instance index is out of range: ${index}`);
    }
    return matrix;
  }

  #disposeRecord(record: NodeRecord): void {
    if (record.disposed) {
      return;
    }

    record.disposed = true;
    this.#records.delete(record.node);
    this.disposeExecution(record.execution, record.node, record.automatic);
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
    prepared: PreparedExecution,
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
        this.disposeExecution(
          prepared.execution,
          prepared.execution.scene,
          prepared.automatic
        );
      } catch (cleanup) {
        throw new AggregateError([error, cleanup], "GLTS node creation and cleanup failed");
      }
      throw error;
    }

    this.#records.set(node, {
      automatic: prepared.automatic,
      disposed: false,
      execution: prepared.execution,
      isPreview,
      matrices,
      node,
      type,
      url
    });
    return node;
  }
}
