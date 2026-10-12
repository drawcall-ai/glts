export type GLTSPhase =
  | "resolve"
  | "fetch"
  | "transform"
  | "evaluate"
  | "construct"
  | "resource"
  | "reload"
  | "dispose";

export interface GLTSErrorContext {
  readonly url: string;
  readonly phase: GLTSPhase;
  readonly importChain?: readonly string[];
}

export class GLTSError extends Error {
  readonly url: string;
  readonly phase: GLTSPhase;
  readonly importChain: readonly string[];

  constructor(message: string, context: GLTSErrorContext, cause?: unknown) {
    const chain = context.importChain ?? [];
    const chainMessage = chain.length > 1 ? `\nImport chain: ${chain.join(" -> ")}` : "";

    super(`[GLTS:${context.phase}] ${message}\nURL: ${context.url}${chainMessage}`, {
      cause
    });

    this.name = "GLTSError";
    this.url = context.url;
    this.phase = context.phase;
    this.importChain = chain;
  }
}

export function toGLTSError(
  error: unknown,
  message: string,
  context: GLTSErrorContext
): GLTSError {
  if (error instanceof GLTSError) {
    return error;
  }

  return new GLTSError(message, context, error);
}

/** Runs every step, then throws an AggregateError of the steps that failed. */
export function runAll(message: string, steps: readonly (() => void)[]): void {
  const errors: unknown[] = [];
  for (const step of steps) {
    try {
      step();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, message);
  }
}

/** Runs `cleanup` after `error`, then rethrows `error`, or both errors when cleanup fails too. */
export function cleanUpAndThrow(error: unknown, url: string, cleanup: () => void): never {
  try {
    cleanup();
  } catch (cleanupError) {
    throw new GLTSError(
      "GLTS operation and cleanup both failed",
      { phase: "dispose", url },
      new AggregateError([error, cleanupError])
    );
  }
  throw error;
}
