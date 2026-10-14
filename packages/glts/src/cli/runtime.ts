import { readFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { installGlobals } from "@drawcall/webgl";
import { LoadingManager } from "three";
import { GLTSLoader } from "../loader/index.js";
import type { GLTSScene } from "../types.js";
import { isBareSpecifier } from "../modules/resolution.js";
import { cleanUpAndThrow } from "../errors.js";

/** Source modules run as data URLs; native package imports belong to the asset's project. */
export async function withScene<T>(source: string, isPreview: boolean, run: (scene: GLTSScene) => Promise<T>): Promise<T> {
  const url = pathToFileURL(resolve(source));
  installGlobals();
  const fetch = globalThis.fetch;
  globalThis.fetch = async (input, options) => {
    const href = input instanceof Request ? input.url : String(input);
    if (!href.startsWith("file:")) return fetch(input, options);
    try {
      return new Response(await readFile(new URL(href)));
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return new Response(null, { status: 404, statusText: "File not found" });
      throw error;
    }
  };
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      // Packages, including their own dependencies, share the host's Three instance.
      if (specifier === "three" || specifier.startsWith("three/")) {
        return nextResolve(specifier, { ...context, parentURL: import.meta.url, conditions: ["node", "import"] });
      }
      if (context.parentURL?.startsWith("data:") && isBareSpecifier(specifier)) {
        return nextResolve(specifier, { ...context, parentURL: url.href });
      }
      return nextResolve(specifier, context);
    }
  });
  const loader = new GLTSLoader(new LoadingManager(), { isPreview, resolve: specifier => specifier });
  try {
    let result: T;
    try { result = await run(await loader.loadAsync(url)); }
    catch (error) { cleanUpAndThrow(error, url.href, () => loader.dispose()); }
    loader.dispose();
    return result;
  } finally {
    hooks.deregister();
    globalThis.fetch = fetch;
  }
}
