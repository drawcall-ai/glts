import * as THREE from "three";
import { GLTSError } from "../errors.js";
import { copyRootState } from "../scene/state.js";
import type { ManagedNodes, NodeRecord } from "../scene/registry.js";
import type { Revision } from "../scene/revision.js";
import type { ScriptModules } from "../modules/scripts.js";
import type { Construction } from "./construction.js";
import type { Operations } from "./operations.js";

interface ReloadContext {
  readonly modules: ScriptModules;
  readonly nodes: ManagedNodes;
  readonly construction: Construction;
  readonly operations: Operations;
}

interface Replacement {
  readonly prepared: Revision;
  readonly record: NodeRecord;
}

export async function reloadRecords(
  url: string,
  records: readonly NodeRecord[],
  { modules, nodes, construction, operations }: ReloadContext
): Promise<void> {
  const script = await modules.prepareScript(url, { reload: true });
  const replacements: Replacement[] = [];

  try {
    for (const record of records) {
      const prepared = await construction.execute(script, {
        matrices: record.matrices,
        isPreview: record.isPreview,
        instances: record.type === "instances",
        requestedURL: url,
        physicsSource: record.revision.execution
      });
      replacements.push({ prepared, record });
      assertPhysicsReloadAllowed(nodes, record, prepared);
    }
  } catch (error) {
    discardRevisionsAndRethrow(url, replacements, error);
  }

  operations.assertActive(url);
  const disposed = replacements.find(({ record }) => record.disposed);
  if (disposed) {
    discardRevisionsAndRethrow(
      url,
      replacements,
      new GLTSError("GLTS node was disposed during reload", {
        phase: "reload",
        url: disposed.record.url
      })
    );
  }

  const disposalErrors: unknown[] = [];
  for (const { prepared, record } of replacements) {
    if (record.disposed) {
      try {
        prepared.dispose();
      } catch (error) {
        disposalErrors.push(error);
      }
      continue;
    }

    try {
      replaceRevision(record, prepared, nodes);
    } catch (error) {
      disposalErrors.push(error);
    }
  }
  modules.cacheScript(url, script);

  if (disposalErrors.length > 0) {
    throw new GLTSError(
      "Reload committed, but cleanup failed",
      { phase: "dispose", url },
      new AggregateError(disposalErrors)
    );
  }
}

function discardRevisionsAndRethrow(
  url: string,
  replacements: readonly Replacement[],
  error: unknown
): never {
  const cleanupErrors: unknown[] = [];
  for (const { prepared } of replacements) {
    try {
      prepared.dispose();
    } catch (cleanup) {
      cleanupErrors.push(cleanup);
    }
  }

  if (cleanupErrors.length > 0) {
    throw new GLTSError("GLTS operation and cleanup both failed",
      { phase: "dispose", url }, new AggregateError([error, ...cleanupErrors]));
  }
  throw error;
}

function replaceRevision(record: NodeRecord, prepared: Revision, nodes: ManagedNodes): void {
  const committed = record.revision.execution.committed;
  const oldChildren = new THREE.Group();
  while (record.node.children.length > 0) {
    const child = record.node.children[0];
    if (!child) {
      break;
    }
    oldChildren.add(child);
  }

  const disposalErrors: unknown[] = [];
  try {
    record.revision.dispose(oldChildren);
  } catch (error) {
    disposalErrors.push(error);
  }

  if (record.disposed) {
    disposalErrors.push(new GLTSError("GLTS node was disposed during reload", {
      phase: "reload", url: record.url
    }));
    try {
      prepared.dispose();
    } catch (error) {
      disposalErrors.push(error);
    }
    throw new AggregateError(disposalErrors, "GLTS replacement was disposed during reload");
  }

  record.revision = prepared;
  copyRootState(record.node, prepared.execution.scene);
  while (prepared.execution.scene.children.length > 0) {
    const child = prepared.execution.scene.children[0];
    if (!child) {
      break;
    }
    record.node.add(child);
  }
  prepared.execution.bindScene(record.node);
  if (committed) nodes.commit(record.node);

  if (disposalErrors.length > 0) {
    throw new AggregateError(disposalErrors, "GLTS revision disposal failed");
  }
}

function assertPhysicsReloadAllowed(nodes: ManagedNodes, record: NodeRecord, prepared: Revision): void {
  if (!prepared.execution.physics) {
    return;
  }
  let ancestor: THREE.Object3D | null = record.node;
  while (ancestor) {
    if (nodes.find(ancestor)?.type === "instances") {
      throw new GLTSError("Physics assets cannot be reloaded inside GLTS instances", {
        phase: "reload",
        url: record.url
      });
    }
    ancestor = ancestor.parent;
  }
}

