import { cleanUpAndThrow, GLTSError, runAll } from "../errors.js";
import { copyRootState } from "../scene/root.js";
import type { NodeRecord } from "../scene/nodes.js";
import type { Execution } from "../scene/execution.js";
import type { ScriptModules } from "../modules/scripts.js";
import type { Construction } from "./construction.js";

interface ReloadContext {
  readonly construction: Construction;
  readonly modules: ScriptModules;
}

interface Replacement {
  readonly replacement: Execution;
  readonly record: NodeRecord;
}

export async function reloadRecords(
  url: string,
  records: readonly NodeRecord[],
  { construction, modules }: ReloadContext
): Promise<void> {
  const script = await modules.fetchScript(url);
  const replacements: Replacement[] = [];
  try {
    for (const record of records) {
      const replacement = await construction.construct(script, {
        matrices: record.matrices,
        isPreview: record.isPreview,
        instances: record.instances,
        requestedURL: url
      });
      replacements.push({ replacement, record });
    }
    const disposed = records.find((record) => record.disposed);
    if (disposed) {
      throw new GLTSError("GLTS node was disposed during reload", { phase: "reload", url: disposed.url });
    }
  } catch (error) {
    cleanUpAndThrow(error, url, () => runAll(
      "GLTS reload discard failed",
      replacements.map(({ replacement }) => () => replacement.dispose())
    ));
  }

  modules.commitScript(url, script);
  try {
    runAll("GLTS reload commit failed", replacements.map(({ replacement, record }) => () => {
      // An earlier replacement's cleanup may have disposed this node.
      if (record.disposed) {
        replacement.dispose();
        return;
      }
      replaceExecution(record, replacement);
    }));
  } catch (error) {
    throw new GLTSError("Reload committed, but cleanup failed", { phase: "dispose", url }, error);
  }
}

function replaceExecution(record: NodeRecord, replacement: Execution): void {
  runAll("GLTS execution replacement failed", [
    // The node keeps its children until the previous execution's disposal callbacks have run.
    () => record.execution.dispose(record.node),
    () => {
      // The previous execution's disposal callbacks may have disposed the node.
      if (record.disposed) {
        cleanUpAndThrow(
          new GLTSError("GLTS node was disposed during reload", { phase: "reload", url: record.url }),
          record.url,
          () => replacement.dispose()
        );
      }

      record.execution = replacement;
      copyRootState(record.node, replacement.scene);
      for (const child of [...replacement.scene.children]) {
        record.node.add(child);
      }
      replacement.bindScene(record.node);
    }
  ]);
}
