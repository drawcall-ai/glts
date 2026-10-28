import { GLTSError } from "../errors.js";

/** One linking attempt, whose waits may cross independently requested scripts. */
export interface Link {
  readonly url: string;
  readonly waits: Set<Link>;
  settled: boolean;
}

export interface Entry<T> {
  readonly promise: Promise<T>;
  readonly link: Link;
}

/** Adds the dependency before awaiting it, rejecting cycles through another caller's cached promise. */
function wait(parent: Link | undefined, child: Link): void {
  if (!parent || child.settled) return;
  const pending = [{ link: child, path: [child.url] }];
  const visited = new Set<Link>();
  for (const { link, path } of pending) {
    if (link === parent) {
      throw new GLTSError("Cyclic imports are not supported", {
        phase: "resolve", url: child.url, importChain: [parent.url, ...path],
      });
    }
    if (link.settled || visited.has(link)) continue;
    visited.add(link);
    pending.push(...[...link.waits].map((next) => ({ link: next, path: [...path, next.url] })));
  }
  parent.waits.add(child);
}

/** Links `url` once until it fails or is invalidated, tracking its active waits separately from its import path. */
export function linkOnce<T>(
  cache: Map<string, Entry<T>>,
  url: string,
  chain: readonly string[],
  create: (chain: readonly string[], link: Link) => Promise<T>,
  parent?: Link,
): Promise<T> {
  if (chain.includes(url)) {
    throw new GLTSError("Cyclic imports are not supported", { importChain: [...chain, url], phase: "resolve", url });
  }
  const cached = cache.get(url);
  if (cached) {
    wait(parent, cached.link);
    return cached.promise;
  }
  const link: Link = { url, waits: new Set(), settled: false };
  wait(parent, link);
  const close = (): void => { link.settled = true; link.waits.clear(); };
  let promise: Promise<T>;
  try { promise = create([...chain, url], link); }
  catch (error) { close(); throw error; }
  const entry = { promise, link };
  cache.set(url, entry);
  void promise.then(close, () => {
    close();
    if (cache.get(url) === entry) cache.delete(url);
  });
  return promise;
}
