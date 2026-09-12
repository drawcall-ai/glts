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
  readonly #scriptLoads = new Map<string, Promise<CompiledScript>>();
  readonly #scripts = new Map<string, CompiledScript>();
  readonly #invalidations = new Map<string, number>();
  readonly #preparations = new WeakMap<CompiledScript, number>();
  #generation = 0;

  constructor(options: ScriptModulesOptions) {
    this.#fetch = options.fetch;
    this.#moduleURLs = options.moduleURLs;
    this.#bridge = options.bridge;
    this.#external = new ExternalModules(options);
  }

  async prepareScript(
    url: string,
    { reload = false }: { readonly reload?: boolean } = {},
  ): Promise<CompiledScript> {
    const cached = this.#scripts.get(url);
    if (cached && !reload) {
      return cached;
    }

    const key = `${reload ? "reload" : "load"}:${url}`;
    let loading = this.#scriptLoads.get(key);
    if (!loading) {
      loading = this.#fetchScript(url, reload, this.#generation);
      this.#scriptLoads.set(key, loading);
      void loading
        .finally(() => {
          if (this.#scriptLoads.get(key) === loading) {
            this.#scriptLoads.delete(key);
          }
        })
        .catch(() => undefined);
    }
    return loading;
  }

  cacheScript(url: string, script: CompiledScript): void {
    const generation = this.#preparations.get(script);
    if (generation === undefined) {
      throw new Error("Cannot cache a script that was not prepared by this loader");
    }
    const invalidated = Math.max(
      this.#invalidations.get(url) ?? 0,
      this.#invalidations.get(script.url) ?? 0
    );
    if (invalidated > generation) {
      // A late redirect can reveal another request URL that needs revalidation.
      this.#invalidations.set(url, invalidated);
      return;
    }
    this.#scripts.set(url, script);
    this.#scripts.set(script.url, script);
  }

  invalidateScript(url: string): void {
    const sourceURL = this.#scripts.get(url)?.url ?? url;
    const aliases = new Set([url, sourceURL]);
    for (const [key, script] of this.#scripts) {
      if (script.url === sourceURL) aliases.add(key);
    }
    const generation = ++this.#generation;
    for (const alias of aliases) {
      this.#invalidations.set(alias, generation);
      this.#scripts.delete(alias);
      this.#scriptLoads.delete(`load:${alias}`);
      this.#scriptLoads.delete(`reload:${alias}`);
    }
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

  async #fetchScript(url: string, reload: boolean, generation: number): Promise<CompiledScript> {
    const fetched = await fetchSource(this.#fetch, url, reload || this.#invalidations.has(url), [url]);
    const source = compileScript(fetched.source, {
      importChain: [fetched.url],
      url: fetched.url,
    });

    const script = { source, url: fetched.url };
    // Invalidation also fences late fetches and reload commits, including redirects
    // whose final URL was unknown when the request started.
    this.#preparations.set(script, generation);
    if (!reload) {
      this.cacheScript(url, script);
    }
    return script;
  }

}

export function canonicalGLTSURL(input: string | URL, baseURL: URL): string {
  return canonicalize(new URL(input, baseURL));
}
