import type { Dependencies } from "./dependencies.js";
import type { GLTSContext } from "./types.js";

/** What code a script runs reaches of its execution. */
export interface RunningExecution {
  readonly context: GLTSContext;
  /** The files the execution uses, which its dynamic imports add to. */
  readonly dependencies: Dependencies;
}

// A realm global, so every copy of the package on the page sees the same execution.
declare global {
  var __drawcallGLTSExecution: RunningExecution | undefined;
}

export function currentExecution(): RunningExecution | undefined {
  return globalThis.__drawcallGLTSExecution;
}

/**
 * The running script's context, for code that cannot import it: helpers, which may import only this from
 * `@drawcall/glts`, and npm or CDN packages. Exposed but deliberately undocumented in the README and skill.
 *
 * Compiled scripts and helpers keep the context across their own `await`s. Native async code, such as a
 * package's, must call this before its first `await`; afterwards, and in independently scheduled callbacks,
 * it throws.
 */
export function getGLTSContext(): GLTSContext {
  const execution = currentExecution();
  if (!execution) throw new Error("No GLTS execution is active");
  return execution.context;
}

export function runWithExecution<T>(execution: RunningExecution | undefined, callback: () => T): T {
  const previous = currentExecution();
  globalThis.__drawcallGLTSExecution = execution;
  try {
    return callback();
  } finally {
    globalThis.__drawcallGLTSExecution = previous;
  }
}

/** Babel's async helpers drive these iterators; scope each step, never the pending promise. */
export function bindGenerator<This, Args extends unknown[], Value, Result, Next>(
  create: (this: This, ...args: Args) => Generator<Value, Result, Next>,
): (this: This, ...args: Args) => Pick<Generator<Value, Result, Next>, "next" | "return" | "throw"> {
  return function (...args) {
    const execution = currentExecution();
    const iterator = create.apply(this, args);
    return {
      next: (...values: [] | [Next]) => runWithExecution(execution, () => iterator.next(...values)),
      return: (value) => runWithExecution(execution, () => iterator.return(value)),
      throw: (error: unknown) => runWithExecution(execution, () => iterator.throw(error)),
    };
  };
}
