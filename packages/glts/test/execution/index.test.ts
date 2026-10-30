import { expect, it, vi } from "vitest";

import { createExecution } from "./fixture.js";

it("rejects retained lifecycle registrations after disposal and disposes reentrantly once", () => {
  const execution = createExecution();
  const hooks = execution.bindings;
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
