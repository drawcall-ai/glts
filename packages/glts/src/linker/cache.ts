import { waitFor, type Waiter } from "../waits.js";

export interface Entry<T> {
  readonly promise: Promise<T>;
  /** The linking attempt, whose waits may cross independently requested scripts. */
  readonly waiter: Waiter;
}

const cyclic = "Cyclic imports are not supported";

/**
 * Links `url` once until it fails or is invalidated. Cycles are found in its active waits, not its import path `chain`,
 * which only names it in errors: a dynamic import of an importer's module back passes no `parent`, and is no cycle.
 */
export function linkOnce<T>(
  cache: Map<string, Entry<T>>,
  url: string,
  chain: readonly string[],
  create: (chain: readonly string[], waiter: Waiter) => Promise<T>,
  parent?: Waiter,
): Promise<T> {
  const cached = cache.get(url);
  if (cached) {
    waitFor(parent, cached.waiter, cyclic);
    return cached.promise;
  }
  const waiter: Waiter = { url, waits: new Set(), settled: false };
  waitFor(parent, waiter, cyclic);
  const close = (): void => { waiter.settled = true; waiter.waits.clear(); };
  const promise = create([...chain, url], waiter);
  const entry = { promise, waiter };
  cache.set(url, entry);
  void promise.then(close, () => {
    close();
    if (cache.get(url) === entry) cache.delete(url);
  });
  return promise;
}
