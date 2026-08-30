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
  let resolveReady = (): void => {
    throw new Error("Root readiness was not initialized");
  };
  let rejectReady = (_reason: unknown): void => {
    throw new Error("Root readiness was not initialized");
  };
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  void ready.catch(() => undefined);

  const fail = (error: unknown): void => {
    if (state !== "pending") {
      return;
    }

    state = "disposed";
    try {
      options.dispose();
      rejectReady(error);
    } catch (cleanupError) {
      rejectReady(cleanupFailure(options.url, error, cleanupError));
    }
  };

  void options.boundary.waitForIdle().then(
    () => {
      if (state !== "pending") {
        return;
      }

      try {
        options.assertActive();
      } catch (error) {
        fail(error);
        return;
      }

      state = "ready";
      resolveReady();
    },
    fail
  );

  return {
    ready,
    dispose: (reason) => {
      if (state === "disposed") {
        return;
      }

      const wasPending = state === "pending";
      state = "disposed";
      if (wasPending) {
        options.boundary.cancel(reason);
      }

      try {
        options.dispose();
      } catch (cleanupError) {
        if (wasPending) {
          rejectReady(cleanupFailure(options.url, reason, cleanupError));
        }
        throw cleanupError;
      }

      if (wasPending) {
        rejectReady(reason ?? new GLTSError(
          "Root was disposed before its resources finished loading",
          { url: options.url, phase: "dispose" }
        ));
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
    void this.ready.catch(() => undefined);
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
