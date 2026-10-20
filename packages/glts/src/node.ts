import type * as THREE from "three";

import type { Dependencies } from "./dependencies.js";
import { cleanUpAndThrow, GLTSError, runAll } from "./errors.js";
import type { Execution } from "./execution/index.js";
import type { ScriptRoot } from "./root.js";
import type { GLTSInstances, GLTSScene } from "./types.js";

/** What a load asks for; a reload repeats it. */
export interface LoadRequest {
  /** The URL the script was requested by, which its node keeps. */
  readonly requestedURL: string;
  readonly matrices: THREE.Matrix4[];
  readonly isPreview: boolean;
  readonly instanced: boolean;
  /** The URLs of the scripts that loaded this one, outermost first; empty for the host's loads. */
  readonly ancestors: readonly string[];
}

/** A script's root once its load returns it. */
type Managed = ScriptRoot & GLTSScene;

interface NodeRecord extends LoadRequest {
  readonly node: Managed;
  execution: Execution;
  /** Called once the node is disposed. */
  readonly disposeListeners: Set<() => void>;
}

/** The record of every undisposed managed node, of any loader. */
const byNode = new WeakMap<THREE.Object3D, NodeRecord>();

function isLive(record: NodeRecord): boolean {
  return byNode.get(record.node) === record;
}

/** The record of the managed `node`, which throws once it is disposed. */
function recordOf(node: GLTSScene): NodeRecord {
  const record = byNode.get(node);
  if (!record) throw new GLTSError("GLTS node has been disposed", { phase: "dispose", url: node.url });
  return record;
}

/** Throws unless `delta`, the time a frame advances by, is a non-negative finite number. */
export function assertDelta(delta: number): void {
  if (!Number.isFinite(delta) || delta < 0) {
    throw new RangeError("GLTS frame delta must be a non-negative finite number");
  }
}

/** Throws unless `node` is an undisposed managed node. */
export function assertUndisposed(node: GLTSScene): void {
  recordOf(node);
}

/**
 * Calls `listener` when the managed `node` is disposed; returns a function that removes it. A disposed node
 * throws, as nothing would release what the listener holds.
 */
export function onNodeDispose(node: GLTSScene, listener: () => void): () => void {
  const listeners = recordOf(node).disposeListeners;
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The files the managed `node` uses, following its reloads. */
export function nodeDependencies(node: GLTSScene): () => Dependencies {
  const record = recordOf(node);
  return () => record.execution.dependencies;
}

/** The undisposed managed nodes of one loader, each run by its latest execution. */
export class NodeRegistry {
  readonly #records = new Set<NodeRecord>();

  /**
   * Makes the root of `execution` a managed node of this loader, with instance methods when `request` asks for
   * instances; a root the script made non-extensible fails its load.
   */
  add(execution: Execution, request: LoadRequest): Managed {
    const scene: Managed = Object.assign(execution.root, {
      url: request.requestedURL,
      dispose: (): void => this.#dispose(record),
      update: (delta: number): void => this.#update(recordOf(scene), delta)
    });
    const node = request.instanced ? addInstanceMethods(scene, request.matrices.length) : scene;
    const record: NodeRecord = { ...request, execution, node, disposeListeners: new Set() };
    byNode.set(node, record);
    this.#records.add(record);
    return node;
  }

  /** The records of the nodes loaded by requesting `requestedURL`. */
  records(requestedURL: string): NodeRecord[] {
    return [...this.#records].filter((record) => record.requestedURL === requestedURL);
  }

  disposeAll(): void {
    runAll("GLTS node disposal failed", [...this.#records].map((record) => () => this.#dispose(record)));
  }

  /**
   * Rebuilds the nodes of `records` with executions of the script requested by `requestedURL` from `execute`,
   * handing them over only once all are built; a node disposed meanwhile fails the rebuild, which disposes them and
   * calls `invalidate`.
   */
  async rebuild(
    records: readonly NodeRecord[],
    requestedURL: string,
    execute: (request: LoadRequest) => Promise<Execution>,
    invalidate: () => void
  ): Promise<void> {
    const replacements: { readonly record: NodeRecord; readonly execution: Execution }[] = [];
    try {
      for (const record of records) {
        replacements.push({ record, execution: await execute(record) });
      }
      const disposed = records.find((record) => !isLive(record));
      if (disposed) {
        throw new GLTSError("GLTS node was disposed during reload", { phase: "reload", url: disposed.requestedURL });
      }
    } catch (error) {
      cleanUpAndThrow(error, requestedURL, () => runAll("GLTS reload discard failed", [
        invalidate,
        ...replacements.map(({ execution }) => () => execution.dispose())
      ]));
    }

    try {
      runAll("GLTS reload commit failed", replacements.map(({ record, execution }) => () =>
        this.#replace(record, execution)));
    } catch (error) {
      throw new GLTSError("Reload committed, but replacing its nodes failed", { phase: "reload", url: requestedURL }, error);
    }
  }

  /** Disposes the node of `record` with the managed nodes below it; a disposed node is skipped. */
  #dispose(record: NodeRecord): void {
    if (!isLive(record)) return;
    byNode.delete(record.node);
    this.#records.delete(record);
    runAll("GLTS node disposal failed", [
      () => this.#disposeDescendants(record),
      () => record.execution.dispose(),
      ...record.disposeListeners
    ]);
  }

  /** Disposes `record`'s execution and the managed nodes below its node, then hands the node to `replacement`. */
  #replace(record: NodeRecord, replacement: Execution): void {
    runAll("GLTS execution replacement failed", [
      () => this.#disposeDescendants(record),
      // Disposed with its children, so disposal callbacks see the scene as they do on dispose().
      () => record.execution.dispose(),
      () => {
        // The node's disposal callbacks, or an earlier node's replacement, may have disposed it.
        if (!isLive(record)) {
          cleanUpAndThrow(
            new GLTSError("GLTS node was disposed during reload", { phase: "reload", url: record.requestedURL }),
            record.requestedURL,
            () => replacement.dispose()
          );
        }
        record.execution = replacement;
        replacement.adopt(record.node);
      }
    ]);
  }

  #update(record: NodeRecord, delta: number): void {
    assertDelta(delta);
    record.execution.update(delta);
    for (const descendant of this.#descendants(record)) {
      descendant.execution.update(delta);
    }
  }

  /** Disposes in reverse traversal order, so nested nodes go before their parents. */
  #disposeDescendants(record: NodeRecord): void {
    runAll("GLTS node disposal failed", this.#descendants(record).reverse().map((descendant) => () => this.#dispose(descendant)));
  }

  /** The managed nodes of this loader below the node of `record`, in traversal order. */
  #descendants(record: NodeRecord): NodeRecord[] {
    const found: NodeRecord[] = [];
    record.node.traverse((object) => {
      const descendant = byNode.get(object);
      if (descendant && descendant !== record && this.#records.has(descendant)) found.push(descendant);
    });
    return found;
  }
}

function addInstanceMethods(node: Managed, count: number): ScriptRoot & GLTSInstances {
  const matrixAt = (index: number): THREE.Matrix4 => {
    const matrix = recordOf(node).matrices[index];
    if (!Number.isSafeInteger(index) || !matrix) {
      throw new RangeError(`GLTS instance index is out of range: ${index}`);
    }
    return matrix;
  };
  const instances: ScriptRoot & GLTSInstances = Object.assign(node, {
    count,
    getMatrixAt: (index: number, matrix: THREE.Matrix4) => matrix.copy(matrixAt(index)),
    setMatrixAt: (index: number, matrix: THREE.Matrix4): ScriptRoot & GLTSInstances => {
      recordOf(node).execution.setMatrixAt(index, matrixAt(index).copy(matrix));
      return instances;
    }
  });
  return instances;
}
