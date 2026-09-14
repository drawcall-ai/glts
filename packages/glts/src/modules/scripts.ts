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
  readonly #scripts = new Map<string, CompiledScript | undefined>();

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
      loading = this.#fetchScript(url, reload);
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
    this.#scripts.set(url, script);
  }

  invalidateScript(url: string): void {
    // Keep a marker so the next load also revalidates the HTTP cache.
    this.#scripts.set(url, undefined);
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

  async #fetchScript(url: string, reload: boolean): Promise<CompiledScript> {
    const fetched = await fetchSource(this.#fetch, url, reload || this.#scripts.has(url), [url]);
    const source = compileScript(fetched.source, {
      importChain: [fetched.url],
      url: fetched.url,
    });

    const script = { source, url: fetched.url };
    if (!reload) {
      this.cacheScript(url, script);
    }
    return script;
  }

}

export function canonicalGLTSURL(input: string | URL, baseURL: URL): string {
  return canonicalize(new URL(input, baseURL));
}
