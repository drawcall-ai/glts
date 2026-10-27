import type * as THREE from "three";

import {
  aggregate,
  cleanUpAndThrow,
  collectError,
  GLTSError,
  toGLTSError,
  type GLTSPhase,
} from "../errors.js";

/** How an item reports a failure that is not a GLTSError. */
export interface ItemFailure {
  readonly message: string;
  readonly phase: GLTSPhase;
}

/**
 * Reports `operation` as one `manager` item and rejects as soon as `signal` aborts, wrapping a failure that is not a
 * GLTSError as `failure`. A value the caller will not receive, because the signal aborted or a manager callback
 * failed, goes to `cleanup`.
 */
export async function trackItem<T>(
  manager: THREE.LoadingManager,
  url: string,
  signal: AbortSignal,
  failure: ItemFailure,
  operation: () => Promise<T>,
  cleanup?: (value: T) => void
): Promise<T> {
  const fail = (error: unknown, callbackErrors: readonly unknown[]): GLTSError => {
    const primary = toGLTSError(error, failure.message, { phase: failure.phase, url });
    return aggregate("GLTS operation and LoadingManager callback both failed", primary, callbackErrors);
  };
  signal.throwIfAborted();
  const errors: unknown[] = [];
  let onAbort = (): void => undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort);
  });

  collectError(errors, () => manager.itemStart(url));
  let value: T;
  try {
    value = await Promise.race([operation(), aborted]);
  } catch (error) {
    collectError(errors, () => manager.itemError(url));
    collectError(errors, () => manager.itemEnd(url));
    throw fail(error, errors);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }

  // A manager callback may itself dispose the loader.
  collectError(errors, () => manager.itemEnd(url));
  if (!signal.aborted && errors.length === 0) {
    return value;
  }

  const error = signal.aborted
    ? fail(signal.reason, errors)
    : new GLTSError("LoadingManager callback failed", { phase: "resource", url }, new AggregateError(errors));
  return cleanUpAndThrow(error, url, () => cleanup?.(value));
}
