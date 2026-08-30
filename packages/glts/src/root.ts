import { GLTSError } from "./errors.js";
import type { LoadingBoundary } from "./loading.js";

export interface RuntimeRoot {
  readonly ready: Promise<void>;
  dispose(reason?: unknown): void;
}

interface RuntimeRootOptions {
  readonly assertActive: () => void;
  readonly boundary: LoadingBoundary;
  readonly dispose: () => void;
  readonly url: string;
}

function cleanupFailure(url: string, error: unknown, cleanupError: unknown): GLTSError {
  return new GLTSError(
    "Resource loading and root cleanup both failed",
    { url, phase: "resource" },
    new AggregateError([error, cleanupError])
  );
}

export function trackRoot(options: RuntimeRootOptions): RuntimeRoot {
  let state: "pending" | "ready" | "disposed" = "pending";
  let rejection: unknown;
  const isDisposed = (): boolean => state === "disposed";
  const ready = (async (): Promise<void> => {
    try {
      await options.boundary.waitForIdle();
      if (isDisposed()) {
        throw rejection;
      }

      options.assertActive();
      state = "ready";
    } catch (error) {
      if (isDisposed()) {
        throw rejection;
      }

      state = "disposed";
      try {
        options.dispose();
      } catch (cleanupError) {
        throw cleanupFailure(options.url, error, cleanupError);
      }

      throw error;
    }
  })();

  return {
    ready,
    dispose: (reason) => {
      if (state === "disposed") {
        return;
      }

      const wasPending = state === "pending";
      state = "disposed";
      rejection = reason ?? new GLTSError(
        "Root was disposed before its resources finished loading",
        { url: options.url, phase: "dispose" }
      );
      if (wasPending) {
        options.boundary.cancel(rejection);
      }

      try {
        options.dispose();
      } catch (cleanupError) {
        if (wasPending) {
          rejection = cleanupFailure(options.url, rejection, cleanupError);
        }
        throw cleanupError;
      }
    }
  };
}

export class RootOwnership {
  readonly ready: Promise<void>;
  readonly #root: RuntimeRoot;
  readonly #url: string;
  readonly #releaseRoot: (ownership: RootOwnership) => void;
  #active = true;
  #disposeReason: unknown;

  constructor(
    root: RuntimeRoot,
    url: string,
    releaseRoot: (ownership: RootOwnership) => void
  ) {
    this.#root = root;
    this.#url = url;
    this.#releaseRoot = releaseRoot;
    this.ready = root.ready.then(
      () => {
        if (!this.#active) {
          throw this.#disposeReason;
        }
      },
      (error: unknown) => {
        try {
          this.#release();
        } catch (releaseError) {
          throw new GLTSError(
            "Root loading and ownership cleanup both failed",
            { url, phase: "resource" },
            new AggregateError([error, releaseError])
          );
        }

        throw error;
      }
    );
  }

  dispose(reason?: unknown): void {
    if (!this.#active) {
      return;
    }

    this.#disposeReason = reason ?? new GLTSError(
      "Instance was disposed before it became ready",
      { url: this.#url, phase: "dispose" }
    );
    const errors: unknown[] = [];
    try {
      this.#root.dispose(this.#disposeReason);
    } catch (error) {
      errors.push(error);
    }

    try {
      this.#release();
    } catch (error) {
      errors.push(error);
    }

    if (errors.length > 0) {
      throw new AggregateError(errors, "GLTS root disposal failed");
    }
  }

  #release(): void {
    if (!this.#active) {
      return;
    }

    this.#active = false;
    this.#releaseRoot(this);
  }
}
