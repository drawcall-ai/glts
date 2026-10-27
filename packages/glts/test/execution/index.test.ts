import { Matrix4 } from "three";
import { expect, it, vi } from "vitest";

import { getGLTSContext, runWithExecution } from "../../src/context.js";
import type { GLTSContext } from "../../src/types.js";
import { createExecution } from "./fixture.js";

it("rejects retained lifecycle registrations after disposal and disposes reentrantly once", () => {
  const execution = createExecution();
  const hooks = execution.context;
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

it("binds lifecycle callbacks to their execution and restores the caller's context", () => {
  const execution = createExecution();
  const hooks = execution.context;
  const outer = createExecution({ matrices: [] });
  const observed: GLTSContext[] = [];
  const capture = () => { observed.push(getGLTSContext()); };
  hooks.onFrame(capture);
  hooks.onMatrixUpdateAt(capture);
  hooks.onDispose(capture);

  runWithExecution(outer, () => {
    execution.update(0.1);
    execution.setMatrixAt(0, new Matrix4());
    execution.dispose();
    expect(getGLTSContext()).toBe(outer.context);
  });
  expect(observed).toEqual([hooks, hooks, hooks, hooks]);
  expect(() => getGLTSContext()).toThrow("No GLTS execution is active");
});

it("restores the execution context when a lifecycle callback throws", () => {
  const execution = createExecution({ matrices: [] });
  execution.context.onFrame(() => { throw new Error("frame failed"); });
  expect(() => execution.update(0.1)).toThrow("frame failed");
  expect(() => getGLTSContext()).toThrow("No GLTS execution is active");
});
