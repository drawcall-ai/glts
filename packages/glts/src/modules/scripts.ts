import type { ScriptContext } from "../scene/execution.js";
import { toGLTSError } from "../errors.js";
import { ExternalModules } from "./external.js";
import { canonicalize, fetchSource } from "./fetch.js";
import type { ModuleURLStore } from "./urls.js";
import { rewriteModule } from "./rewrite.js";
import type { ModuleBridge } from "./bridge.js";
import { compileScript } from "./compiler.js";
import type { GLTSFetch } from "../types.js";

export interface CompiledScript {
  readonly source: string;
  readonly url: string;
}

interface ScriptModulesOptions {
  readonly cdnURL: URL;
  readonly fetch: GLTSFetch;
  readonly moduleURLs: ModuleURLStore;
  readonly bridge: ModuleBridge;
  readonly threeRevision: string;
}

async function importModule(moduleURL: string): Promise<unknown> {
  return import(/* @vite-ignore */ moduleURL);
}

export class ScriptModules {
  readonly #external: ExternalModules;
  readonly #fetch: GLTSFetch;
  readonly #moduleURLs: ModuleURLStore;
  readonly #bridge: ModuleBridge;
  readonly #scriptCache = new Map<string, Promise<CompiledScript> | "invalidated">();

  constructor(options: ScriptModulesOptions) {
    this.#fetch = options.fetch;
    this.#moduleURLs = options.moduleURLs;
    this.#bridge = options.bridge;
    this.#external = new ExternalModules(options);
  }

  async prepareScript(
    requestedURL: string,
    { reload = false }: { readonly reload?: boolean } = {},
  ): Promise<CompiledScript> {
    // Reloads hold the write lock and cache only after scene changes commit.
    if (reload) return this.#fetchScript(requestedURL, true);

    const cached = this.#scriptCache.get(requestedURL);
    if (cached !== undefined && cached !== "invalidated") {
      return cached;
    }

    const loading = this.#fetchScript(requestedURL, cached === "invalidated");
    // The promise shares both pending work and its completed result.
    this.#scriptCache.set(requestedURL, loading);
    try {
      return await loading;
    } catch (error) {
      if (cached === "invalidated") {
        this.#scriptCache.set(requestedURL, "invalidated");
      } else {
        this.#scriptCache.delete(requestedURL);
      }
      throw error;
    }
  }

  commitScript(requestedURL: string, script: CompiledScript): void {
    // script.url may be a redirect target; cache and lock keys use the request URL.
    this.#scriptCache.set(requestedURL, Promise.resolve(script));
  }

  invalidateScript(requestedURL: string): void {
    this.#scriptCache.set(requestedURL, "invalidated");
  }

  async executeScript(script: CompiledScript, context: ScriptContext): Promise<void> {
    const contextModule = this.#bridge.createContextModule(context);
    const external = this.#external.forContext(context);
    let transformed: string;
    try {
      transformed = await rewriteModule({
        importChain: [script.url],
        resolveImport: async (specifier, importerURL, chain) => {
          if (specifier === "@drawcall/glts") return contextModule.url;
          const module = await external.prepareImport(specifier, importerURL, chain, "script");
          if (module.physics) context.declarePhysics();
          return module.url;
        },
        source: script.source,
        sourceURL: script.url,
      });
    } catch (error) {
      contextModule.release();
      throw toGLTSError(error, "Unable to transform GLTS script", {
        importChain: [script.url],
        phase: "transform",
        url: script.url,
      });
    }

    const moduleURL = this.#moduleURLs.create(transformed);
    try {
      await importModule(moduleURL);
    } catch (error) {
      throw toGLTSError(error, "Unable to execute GLTS script", {
        importChain: [script.url],
        phase: "evaluate",
        url: script.url,
      });
    } finally {
      this.#moduleURLs.release(moduleURL);
      contextModule.release();
    }
  }

  async #fetchScript(url: string, revalidateSource: boolean): Promise<CompiledScript> {
    const fetched = await fetchSource(this.#fetch, url, revalidateSource, [url]);
    const source = compileScript(fetched.source, {
      importChain: [fetched.url],
      url: fetched.url,
    });

    return { source, url: fetched.url };
  }
}

export function canonicalGLTSURL(input: string | URL, baseURL: URL): string {
  return canonicalize(new URL(input, baseURL));
}
