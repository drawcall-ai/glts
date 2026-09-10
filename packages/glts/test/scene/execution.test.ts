import { expect, it, vi } from "vitest";
import { LoadingManager, Matrix4 } from "three";
import { Execution } from "../../src/scene/execution.js";

function context(execution: Execution) {
  return execution.context({
    gltsLoader: {
      loadAsync: async () => { throw new Error("Unexpected nested load"); },
      loadInstancesAsync: async () => { throw new Error("Unexpected nested load"); }
    },
    loadingManager: new LoadingManager(),
    isPreview: false
  });
}

it("rejects retained lifecycle registrations after disposal and disposes reentrantly once", () => {
  const execution = new Execution([new Matrix4()], ["https://example.test/scene.glts"]);
  const hooks = context(execution);
  const disposed = vi.fn(() => execution.dispose());
  hooks.onDispose(disposed);
  execution.dispose();
  execution.dispose();
  expect(disposed).toHaveBeenCalledTimes(1);

  const callback = vi.fn();
  for (const register of [hooks.onDispose, hooks.onFrame, hooks.onMatrixUpdateAt]) {
    expect(() => register(callback)).toThrow("execution has been disposed");
  }
  expect(callback).not.toHaveBeenCalled();
});

