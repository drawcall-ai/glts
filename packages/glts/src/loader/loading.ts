import * as THREE from "three";

import { cleanUpAndThrow, GLTSError, toGLTSError } from "../errors.js";

/** Runs a LoadingManager callback, collecting its failure so the item stays balanced. */
function notify(errors: unknown[], callback: () => void): void {
  try {
    callback();
  } catch (error) {
    errors.push(error);
  }
}

function loadFailure(url: string, error: unknown, notificationErrors: readonly unknown[]): GLTSError {
  const primary = toGLTSError(error, "Unable to load GLTS script", { phase: "evaluate", url });
  if (notificationErrors.length === 0) {
    return primary;
  }

  return new GLTSError(
    "GLTS operation and LoadingManager callback both failed",
    { importChain: primary.importChain, phase: primary.phase, url: primary.url },
    new AggregateError([primary, ...notificationErrors])
  );
}

/**
 * Reports `operation` as one `manager` item and rejects as soon as `signal` aborts. A value the
 * caller will not receive, because the signal aborted or a manager callback failed, goes to `cleanup`.
 */
export async function trackItem<T>(
  manager: THREE.LoadingManager,
  url: string,
  signal: AbortSignal,
  operation: () => Promise<T>,
  cleanup: (value: T) => void = () => undefined
): Promise<T> {
  signal.throwIfAborted();
  const errors: unknown[] = [];
  let onAbort = (): void => undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort);
  });

  notify(errors, () => manager.itemStart(url));
  let value: T;
  try {
    value = await Promise.race([operation(), aborted]);
  } catch (error) {
    notify(errors, () => manager.itemError(url));
    notify(errors, () => manager.itemEnd(url));
    throw loadFailure(url, error, errors);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }

  // A manager callback may itself dispose the loader.
  notify(errors, () => manager.itemEnd(url));
  if (signal.aborted) {
    cleanUpAndThrow(loadFailure(url, signal.reason, errors), url, () => cleanup(value));
  }
  if (errors.length > 0) {
    const error = new GLTSError("LoadingManager callback failed", { phase: "resource", url }, new AggregateError(errors));
    cleanUpAndThrow(error, url, () => cleanup(value));
  }
  return value;
}

interface Completion {
  readonly reject: (error: unknown) => void;
  readonly resolve: () => void;
}

export class LoadingScope {
  readonly manager: THREE.LoadingManager;
  readonly #errors: unknown[] = [];
  readonly #failedURLs: string[] = [];
  readonly #rootURL: string;
  #active = true;
  #completion: Completion | undefined;
  #pending = 0;

  constructor(host: THREE.LoadingManager, rootURL: string) {
    this.#rootURL = rootURL;
    const manager = new THREE.LoadingManager();
    const itemStart = manager.itemStart.bind(manager);
    const itemEnd = manager.itemEnd.bind(manager);
    const itemError = manager.itemError.bind(manager);
    const getHandler = manager.getHandler.bind(manager);

    manager.resolveURL = (url): string => host.resolveURL(url);
    manager.getHandler = (url) => {
      const handler = getHandler(url);
      if (handler) {
        return handler;
      }
      if (host.getHandler(url)) {
        throw new GLTSError(
          "Host LoadingManager handlers cannot be scoped; register the handler with the contextual loadingManager",
          { phase: "resource", url: this.#rootURL }
        );
      }
      return null;
    };
    manager.itemStart = (url): void => {
      this.#assertActive();
      this.#pending += 1;
      notify(this.#errors, () => itemStart(url));
      notify(this.#errors, () => host.itemStart(url));
    };
    manager.itemError = (url): void => {
      this.#failedURLs.push(url);
      notify(this.#errors, () => itemError(url));
      notify(this.#errors, () => host.itemError(url));
    };
    manager.itemEnd = (url): void => {
      if (this.#pending === 0) {
        throw new Error(`LoadingManager item ended without a matching start: ${url}`);
      }

      this.#pending -= 1;
      notify(this.#errors, () => itemEnd(url));
      notify(this.#errors, () => host.itemEnd(url));
      this.#settle();
    };
    this.manager = manager;
  }

  cancel(reason: unknown): void {
    if (!this.#active) {
      return;
    }

    this.#active = false;
    this.manager.abort();
    this.#completion?.reject(reason);
    this.#completion = undefined;
  }

  async waitAndClose(): Promise<void> {
    await Promise.resolve();
    this.#assertActive();
    if (this.#pending > 0) {
      await new Promise<void>((resolve, reject) => {
        this.#completion = { reject, resolve };
      });
    }

    this.#active = false;
    this.#throwFailures();
  }

  #assertActive(): void {
    if (!this.#active) {
      throw new GLTSError("Loading scope is no longer active", {
        phase: "dispose",
        url: this.#rootURL
      });
    }
  }

  #settle(): void {
    if (this.#pending !== 0 || !this.#completion) {
      return;
    }

    const completion = this.#completion;
    this.#completion = undefined;
    completion.resolve();
  }

  #throwFailures(): void {
    if (this.#failedURLs.length === 0 && this.#errors.length === 0) {
      return;
    }

    const failures = this.#failedURLs.map((url) => `- ${url}`).join("\n");
    const message = failures
      ? `Resources failed to load:\n${failures}`
      : "LoadingManager callback failed";
    const cause = this.#errors.length > 0
      ? new AggregateError(this.#errors, "LoadingManager callbacks failed")
      : undefined;
    throw new GLTSError(message, {
      phase: "resource",
      url: this.#rootURL
    }, cause);
  }
}
