import { LoadingManager } from "three";
import { afterEach, vi } from "vitest";

import { GLTSLoader } from "../../src/loader/index.js";
import type { GLTSModules } from "../../src/types.js";

export const base = "https://assets.test/";
const loaders: GLTSLoader[] = [];

afterEach(() => {
  for (const loader of loaders.splice(0)) loader.dispose();
  vi.unstubAllGlobals();
});

/** A loader fetching `sources` by path below `base`, with `library` as a host module. */
export function serve(sources: Record<string, string>, library: object = {}, modules: GLTSModules = {}): GLTSLoader {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const source = sources[new URL(input instanceof Request ? input.url : String(input)).pathname.slice(1)];
    return source === undefined ? new Response(null, { status: 404 }) : new Response(source);
  });
  const loader = new GLTSLoader(new LoadingManager(), { modules: { ...modules, library } });
  loaders.push(loader);
  return loader;
}

/** A promise the test resolves by calling `resolve`. */
export function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => { throw new Error("Deferred promise was not initialized"); };
  const promise = new Promise<void>((complete) => { resolve = complete; });
  return { promise, resolve };
}
