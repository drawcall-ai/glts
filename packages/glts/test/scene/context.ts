import { LoadingManager } from "three";
import type { Execution, ScriptContext } from "../../src/scene/execution.js";

/** The script context of `execution`, with a gltsLoader that rejects nested loads. */
export function context(execution: Execution): ScriptContext {
  return execution.context({
    gltsLoader: {
      loadAsync: async () => { throw new Error("Unexpected nested load"); },
      loadInstancesAsync: async () => { throw new Error("Unexpected nested load"); }
    },
    loadingManager: new LoadingManager(),
    isPreview: false
  });
}
