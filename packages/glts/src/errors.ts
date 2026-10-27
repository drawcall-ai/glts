/** The phase a GLTS error arose in; "transform" covers compiling a script or helper and linking its imports. */
export type GLTSPhase =
  | "resolve"
  | "fetch"
  | "transform"
  | "evaluate"
  | "construct"
  | "resource"
  | "reload"
  | "dispose";

export interface GLTSErrorDetails {
  readonly url: string;
  readonly phase: GLTSPhase;
  readonly importChain?: readonly string[];
}

export class GLTSError extends Error {
  readonly url: string;
  readonly phase: GLTSPhase;
  readonly importChain: readonly string[];

  constructor(message: string, details: GLTSErrorDetails, cause?: unknown) {
    const chain = details.importChain ?? [];
    const chainMessage = chain.length > 1 ? `\nImport chain: ${chain.join(" -> ")}` : "";

    super(`[GLTS:${details.phase}] ${message}\nURL: ${details.url}${chainMessage}`, {
      cause
    });

    this.name = "GLTSError";
    this.url = details.url;
    this.phase = details.phase;
    this.importChain = chain;
  }
}

export function toGLTSError(
  error: unknown,
  message: string,
  details: GLTSErrorDetails
): GLTSError {
  if (error instanceof GLTSError) {
    return error;
  }

  return new GLTSError(message, details, error);
}

/** Runs `step`, adding its failure to `errors` instead of throwing it. */
export function collectError(errors: unknown[], step: () => void): void {
  try {
    step();
  } catch (error) {
    errors.push(error);
  }
}

/** Runs every step, then throws an AggregateError of the steps that failed. */
export function runAll(message: string, steps: readonly (() => void)[]): void {
  const errors: unknown[] = [];
  for (const step of steps) collectError(errors, step);
  if (errors.length > 0) {
    throw new AggregateError(errors, message);
  }
}

/** `primary`, or, with other distinct failures, an error with its phase and URL that aggregates them all. */
export function aggregate(message: string, primary: GLTSError, others: readonly unknown[]): GLTSError {
  const errors = [...new Set([primary, ...others])];
  if (errors.length === 1) return primary;
  return new GLTSError(message, primary, new AggregateError(errors));
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
