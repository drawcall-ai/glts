import * as THREE from "three";
import { cleanUpAndThrow, GLTSError, runAll } from "../errors.js";
import { copyRootState } from "../scene/state.js";
import type { NodeRecord } from "../scene/registry.js";
import type { Execution } from "../scene/execution.js";
import type { ScriptModules } from "../modules/scripts.js";
import type { Construction } from "./construction.js";
import type { Operations } from "./operations.js";

interface ReloadContext {
  readonly modules: ScriptModules;
  readonly construction: Construction;
  readonly operations: Operations;
}

interface Replacement {
  readonly prepared: Execution;
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
        instances: record.instances,
        requestedURL: url
      });
      replacements.push({ prepared, record });
    }
    operations.assertActive(url);
    const disposed = records.find((record) => record.disposed);
    if (disposed) {
      throw new GLTSError("GLTS node was disposed during reload", { phase: "reload", url: disposed.url });
    }
  } catch (error) {
    cleanUpAndThrow(error, url, () => runAll(
      "GLTS reload discard failed",
      replacements.map(({ prepared }) => () => prepared.dispose())
    ));
  }

  modules.commitScript(url, script);
  try {
    runAll("GLTS reload commit failed", replacements.map(({ prepared, record }) => () => {
      // An earlier replacement's cleanup may have disposed this node.
      if (record.disposed) {
        prepared.dispose();
        return;
      }
      replaceExecution(record, prepared);
    }));
  } catch (error) {
    throw new GLTSError("Reload committed, but cleanup failed", { phase: "dispose", url }, error);
  }
}

function replaceExecution(record: NodeRecord, prepared: Execution): void {
  const previous = new THREE.Group();
  for (const child of [...record.node.children]) {
    previous.add(child);
  }

  runAll("GLTS execution replacement failed", [
    () => record.execution.dispose(previous),
    () => {
      // The previous execution's disposal callbacks may have disposed the node.
      if (record.disposed) {
        cleanUpAndThrow(
          new GLTSError("GLTS node was disposed during reload", { phase: "reload", url: record.url }),
          record.url,
          () => prepared.dispose()
        );
      }

      record.execution = prepared;
      copyRootState(record.node, prepared.scene);
      for (const child of [...prepared.scene.children]) {
        record.node.add(child);
      }
      prepared.bindScene(record.node);
    }
  ]);
}
