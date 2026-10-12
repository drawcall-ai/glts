import { expect, it, vi } from "vitest";
import { Matrix4 } from "three";
import { Execution } from "../../src/scene/execution.js";
import { context } from "./context.js";

it("rejects retained lifecycle registrations after disposal and disposes reentrantly once", () => {
  const execution = new Execution([new Matrix4()], ["https://example.test/scene.glts"], () => {});
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

