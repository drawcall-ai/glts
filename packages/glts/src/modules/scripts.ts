import type { ScriptContext } from "../scene/execution.js";
import { toGLTSError } from "../errors.js";
import { ExternalModules } from "./external.js";
import { fetchSource } from "./fetch.js";
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

export class ScriptModules {
  private readonly external: ExternalModules;
  private readonly scriptCache = new Map<string, Promise<CompiledScript>>();

  constructor(private readonly options: ScriptModulesOptions) {
    this.external = new ExternalModules(options);
  }

  async prepareScript(
    requestedURL: string,
    { reload = false }: { readonly reload?: boolean } = {},
  ): Promise<CompiledScript> {
    const cached = this.scriptCache.get(requestedURL);
    if (cached && !reload) {
      return cached;
    }

    const loading = fetchSource(this.options.fetch, requestedURL, true, [requestedURL])
      .then(({ source, url }) => ({
        source: compileScript(source, { importChain: [url], url }),
        url,
      }));
    // Reloads cache the replacement only after scene changes commit.
    if (reload) return loading;

    this.scriptCache.set(requestedURL, loading);
    try {
      return await loading;
    } catch (error) {
      this.scriptCache.delete(requestedURL);
      throw error;
    }
  }

  commitScript(requestedURL: string, script: CompiledScript): void {
    // script.url may be a redirect target; cache and lock keys use the request URL.
    this.scriptCache.set(requestedURL, Promise.resolve(script));
  }

  invalidateScript(requestedURL: string): void {
    this.scriptCache.delete(requestedURL);
  }

  async executeScript(script: CompiledScript, context: ScriptContext): Promise<void> {
    const contextModule = this.options.bridge.createContextModule(context);
    const external = this.external.forContext(context);
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

    const moduleURL = this.options.moduleURLs.create(transformed);
    try {
      await import(/* @vite-ignore */ moduleURL);
    } catch (error) {
      throw toGLTSError(error, "Unable to execute GLTS script", {
        importChain: [script.url],
        phase: "evaluate",
        url: script.url,
      });
    } finally {
      this.options.moduleURLs.release(moduleURL);
      contextModule.release();
    }
  }
}
