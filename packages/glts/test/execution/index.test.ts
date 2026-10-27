import { Matrix4 } from "three";
import { expect, it, vi } from "vitest";

import { getGLTSSource, runWithExecution } from "../../src/execution/current.js";
import type { GLTSSource } from "../../src/types.js";
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

it("binds lifecycle callbacks to their execution and restores the caller's execution", () => {
  const execution = createExecution();
  const hooks = execution.bindings;
  const outer = createExecution({ matrices: [] });
  const observed: GLTSSource[] = [];
  const capture = () => { observed.push(getGLTSSource()); };
  hooks.onFrame(capture);
  hooks.onMatrixUpdateAt(capture);
  hooks.onDispose(capture);

  runWithExecution(outer, () => {
    const caller = getGLTSSource();
    execution.update(0.1);
    execution.setMatrixAt(0, new Matrix4());
    execution.dispose();
    expect(getGLTSSource()).toBe(caller);
  });
  expect(observed).toHaveLength(4);
  for (const source of observed) expect(source).toBe(execution.source);
  expect(() => getGLTSSource()).toThrow("No GLTS execution is active");
});

it("restores the current execution when a lifecycle callback throws", () => {
  const execution = createExecution({ matrices: [] });
  execution.bindings.onFrame(() => { throw new Error("frame failed"); });
  expect(() => execution.update(0.1)).toThrow("frame failed");
  expect(() => getGLTSSource()).toThrow("No GLTS execution is active");
});
