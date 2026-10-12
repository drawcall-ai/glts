import { cleanUpAndThrow, GLTSError, runAll } from "../errors.js";
import type { LinkedScript, ScriptModules } from "../modules/scripts.js";
import type { Execution } from "../scene/execution.js";
import type { LoadRequest, NodeRecord } from "../scene/nodes.js";
import { copyRootState } from "../scene/root.js";

type Construct = (script: LinkedScript, request: LoadRequest) => Promise<Execution>;

interface Replacement {
  readonly record: NodeRecord;
  readonly execution: Execution;
}

/**
 * Constructs a replacement execution for every record from a fresh fetch of `url`, then commits the
 * source and swaps the replacements in.
 */
export async function reloadRecords(
  url: string,
  records: readonly NodeRecord[],
  modules: ScriptModules,
  construct: Construct
): Promise<void> {
  const script = await modules.fetchScript(url);
  const replacements: Replacement[] = [];
  try {
    for (const record of records) {
      replacements.push({ record, execution: await construct(script, record) });
    }
    const disposed = records.find((record) => record.disposed);
    if (disposed) {
      throw new GLTSError("GLTS node was disposed during reload", { phase: "reload", url: disposed.url });
    }
  } catch (error) {
    cleanUpAndThrow(error, url, () => runAll(
      "GLTS reload discard failed",
      replacements.map(({ execution }) => () => execution.dispose())
    ));
  }

  modules.commitScript(url, script);
  try {
    runAll("GLTS reload commit failed", replacements.map(({ record, execution }) => () => {
      // An earlier replacement's cleanup may have disposed this node.
      if (record.disposed) {
        execution.dispose();
        return;
      }
      replaceExecution(record, execution);
    }));
  } catch (error) {
    throw new GLTSError("Reload committed, but cleanup failed", { phase: "dispose", url }, error);
  }
}

function replaceExecution(record: NodeRecord, replacement: Execution): void {
  runAll("GLTS execution replacement failed", [
    // Disposed with its children, so disposal callbacks see the scene as they do on dispose().
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
