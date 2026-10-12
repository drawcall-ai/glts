import * as THREE from "three";
import { cleanUpAndThrow, GLTSError, runAll } from "../errors.js";
import { copyRootState } from "../scene/state.js";
import type { NodeRecord } from "../scene/registry.js";
import type { Revision } from "../scene/revision.js";
import type { ScriptModules } from "../modules/scripts.js";
import type { Construction } from "./construction.js";
import type { Operations } from "./operations.js";

interface ReloadContext {
  readonly modules: ScriptModules;
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
  { modules, construction, operations }: ReloadContext
): Promise<void> {
  const script = await modules.fetchScript(url);
  const replacements: Replacement[] = [];

  try {
    for (const record of records) {
      const prepared = await construction.execute(script, {
        matrices: record.matrices,
        isPreview: record.isPreview,
        instances: record.type === "instances",
        requestedURL: url
      });
      replacements.push({ prepared, record });
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

  modules.commitScript(url, script);
  try {
    runAll("GLTS revision replacement failed", replacements.map(({ prepared, record }) => () => {
      // An earlier replacement's cleanup may have disposed this node.
      if (record.disposed) {
        prepared.dispose();
        return;
      }
      replaceRevision(record, prepared);
    }));
  } catch (error) {
    throw new GLTSError("Reload committed, but cleanup failed", { phase: "dispose", url }, error);
  }
}

function discardRevisionsAndRethrow(
  url: string,
  replacements: readonly Replacement[],
  error: unknown
): never {
  cleanUpAndThrow(error, url, () => runAll(
    "GLTS revision disposal failed",
    replacements.map(({ prepared }) => () => prepared.dispose())
  ));
}

function replaceRevision(record: NodeRecord, prepared: Revision): void {
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

  if (disposalErrors.length > 0) {
    throw new AggregateError(disposalErrors, "GLTS revision disposal failed");
  }
}
