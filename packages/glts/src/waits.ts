import { GLTSError } from "./errors.js";

/** One pending piece of work that others await through a shared promise, and the work it awaits in turn. */
export interface Waiter {
  readonly url: string;
  readonly waits: Set<Waiter>;
  settled: boolean;
}

/**
 * Records that `parent` waits for `child`, rejecting with `message` the wait that would close a cycle, which no
 * import path shows when the waits cross another caller's shared promise.
 */
export function waitFor(parent: Waiter | undefined, child: Waiter, message: string): void {
  if (!parent || child.settled) return;
  const pending = [{ waiter: child, path: [child.url] }];
  const visited = new Set<Waiter>();
  for (const { waiter, path } of pending) {
    if (waiter === parent) {
      throw new GLTSError(message, { phase: "resolve", url: child.url, importChain: [parent.url, ...path] });
    }
    if (waiter.settled || visited.has(waiter)) continue;
    visited.add(waiter);
    pending.push(...[...waiter.waits].map((next) => ({ waiter: next, path: [...path, next.url] })));
  }
  parent.waits.add(child);
}
