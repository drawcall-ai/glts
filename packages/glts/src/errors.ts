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
