import type * as THREE from "three";

import { GLTSError, toGLTSError } from "./errors.js";
import { URLLocks } from "./url-locks.js";

interface ActiveOperation {
  readonly cancel: (error: GLTSError) => void;
}

function loadingFailure(
  url: string,
  operationError: unknown,
  notificationErrors: readonly unknown[]
): GLTSError {
  const primary = toGLTSError(operationError, "Unable to load GLTS script", {
    phase: "evaluate",
    url
  });
  if (notificationErrors.length === 0) {
    return primary;
  }

  return new GLTSError(
    "GLTS operation and LoadingManager callback both failed",
    {
      importChain: primary.importChain,
      phase: primary.phase,
      url: primary.url
    },
    new AggregateError([primary, ...notificationErrors])
  );
}

function notificationFailure(
  url: string,
  errors: readonly unknown[]
): GLTSError {
  return new GLTSError("LoadingManager callback failed", {
    phase: "resource",
    url
  }, new AggregateError(errors));
}

export class Operations {
  readonly #active = new Set<ActiveOperation>();
  readonly #locks = new URLLocks();
  readonly #manager: THREE.LoadingManager;
  #disposed = false;

  constructor(manager: THREE.LoadingManager) {
    this.#manager = manager;
  }

  assertActive(url: string): void {
    if (!this.#disposed) {
      return;
    }

    throw new GLTSError("Loader has been disposed", {
      phase: "dispose",
      url
    });
  }

  dispose(): void {
    if (this.#disposed) {
      return;
    }

    this.#disposed = true;
    const reason = new GLTSError("Loader has been disposed", {
      phase: "dispose",
      url: "glts://loader"
    });
    for (const operation of this.#active) {
      operation.cancel(reason);
    }
  }

  read<T>(url: string, operation: () => Promise<T>): Promise<T> {
    return this.#run(url, () => this.#locks.read(url), operation);
  }

  readNested<T>(url: string, operation: () => Promise<T>): Promise<T> {
    return this.#run(
      url,
      () => this.#locks.readBeforeQueuedWrite(url),
      operation
    );
  }

  write<T>(url: string, operation: () => Promise<T>): Promise<T> {
    return this.#run(url, () => this.#locks.write(url), operation);
  }

  async track<T>(
    url: string,
    operation: () => Promise<T>,
    cleanup: (value: T) => void
  ): Promise<T> {
    this.assertActive(url);
    let cancel: (error: GLTSError) => void = () => undefined;
    const cancellation = new Promise<never>((_resolve, reject) => {
      cancel = reject;
    });
    const active = { cancel };
    this.#active.add(active);
    const notificationErrors: unknown[] = [];
    const notify = (callback: () => void): void => {
      try {
        callback();
      } catch (error) {
        notificationErrors.push(error);
      }
    };

    notify(() => this.#manager.itemStart(url));
    let outcome:
      | { readonly error: unknown; readonly ok: false }
      | { readonly ok: true; readonly value: T }
      | undefined;
    try {
      const work = Promise.resolve().then(() => {
        this.assertActive(url);
        return operation();
      });
      const value = await Promise.race([work, cancellation]);
      this.assertActive(url);
      outcome = { ok: true, value };
    } catch (error) {
      outcome = { error, ok: false };
      notify(() => this.#manager.itemError(url));
    } finally {
      notify(() => this.#manager.itemEnd(url));
      this.#active.delete(active);
    }

    if (!outcome) {
      throw new Error("GLTS operation completed without an outcome");
    }

    let disposalError: unknown;
    if (outcome.ok) {
      try {
        this.assertActive(url);
      } catch (error) {
        disposalError = error;
      }
    }

    if (outcome.ok && !disposalError && notificationErrors.length === 0) {
      return outcome.value;
    }

    let error: GLTSError;
    if (!outcome.ok) {
      error = loadingFailure(url, outcome.error, notificationErrors);
    } else if (disposalError) {
      error = loadingFailure(url, disposalError, notificationErrors);
    } else {
      error = notificationFailure(url, notificationErrors);
    }
    if (outcome.ok) {
      try {
        cleanup(outcome.value);
      } catch (cleanupError) {
        throw new GLTSError(
          "GLTS operation and cleanup both failed",
          { phase: "dispose", url },
          new AggregateError([error, cleanupError])
        );
      }
    }
    throw error;
  }

  async #run<T>(
    url: string,
    acquire: () => Promise<() => void>,
    operation: () => Promise<T>
  ): Promise<T> {
    this.assertActive(url);
    const release = await acquire();
    try {
      this.assertActive(url);
      return await operation();
    } finally {
      release();
    }
  }
}
