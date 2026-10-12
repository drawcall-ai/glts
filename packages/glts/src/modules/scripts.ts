import type { ScriptContext } from "../scene/execution.js";
import { GLTSError, toGLTSError } from "../errors.js";
import { ExternalModules } from "./external.js";
import { canonicalize, fetchSource } from "./fetch.js";
import type { ModuleURLStore } from "./urls.js";
import { importSpecifiers, rewriteModule } from "./rewrite.js";
import type { ModuleBridge } from "./bridge.js";
import { compileHelper, compileScript } from "./compiler.js";
import { helperURL } from "./resolution.js";
import type { GLTSFetch } from "../types.js";

export interface CompiledScript {
  readonly source: string;
  readonly url: string;
  /** Module URLs by specifier, for every import but `@drawcall/glts`, which each execution binds. */
  readonly imports: ReadonlyMap<string, string>;
}

/** The helpers of one script source being prepared. */
interface Linking {
  /** Helper module URLs by helper URL, so each helper has one instance per script source. */
  readonly modules: Map<string, Promise<string>>;
  /** Every helper URL the script has ever imported. */
  readonly urls: Set<string>;
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
  /** Every helper URL a script has imported, by script URL. */
  private readonly scriptHelpers = new Map<string, Set<string>>();

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

    const loading = this.prepare(requestedURL);
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

  /** The scripts that import the helper at `url`, including scripts still fetching it. */
  dependents(url: string): string[] {
    return [...this.scriptHelpers]
      .filter(([, helpers]) => helpers.has(url))
      .map(([script]) => script);
  }

  async executeScript(script: CompiledScript, context: ScriptContext): Promise<void> {
    const contextModule = this.options.bridge.createContextModule(context);
    let transformed: string;
    try {
      transformed = await rewriteModule({
        importChain: [script.url],
        resolveImport: async (specifier) => {
          if (specifier === "@drawcall/glts") return contextModule.url;
          const url = script.imports.get(specifier);
          if (!url) throw new Error(`Import was not prepared: ${specifier}`);
          return url;
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
      // Blob URLs are resolved by the browser at runtime, never by a bundler.
      await import(/* @vite-ignore */ /* webpackIgnore: true */ moduleURL);
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

  private async prepare(requestedURL: string): Promise<CompiledScript> {
    const { source, url } = await fetchSource(this.options.fetch, requestedURL, true, [requestedURL]);
    const compiled = compileScript(source, { importChain: [url], url });
    // Never shrinks, so fixing a helper that failed, or that an older revision imports, reloads the script.
    const urls = this.scriptHelpers.get(requestedURL) ?? new Set<string>();
    this.scriptHelpers.set(requestedURL, urls);
    const linking: Linking = { modules: new Map(), urls };
    const imports = new Map<string, string>();
    try {
      for (const specifier of importSpecifiers({ source: compiled, sourceURL: url, importChain: [url] })) {
        if (specifier === "@drawcall/glts" || imports.has(specifier)) continue;
        imports.set(specifier, await this.prepareImport(specifier, url, [url], linking));
      }
    } catch (error) {
      throw toGLTSError(error, "Unable to transform GLTS script", {
        importChain: [url],
        phase: "transform",
        url,
      });
    }
    return { source: compiled, url, imports };
  }

  private prepareImport(
    specifier: string,
    importerURL: string,
    importChain: readonly string[],
    linking: Linking,
  ): Promise<string> {
    const url = helperURL(specifier, importerURL);
    if (!url) return this.external.prepareImport(specifier, importerURL, importChain, "script");

    const key = canonicalize(url);
    if (importChain.includes(key)) {
      return Promise.reject(new GLTSError("Cyclic helper imports are not supported", {
        importChain: [...importChain, key],
        phase: "resolve",
        url: key,
      }));
    }

    // Recorded before the fetch, so a change from here on reloads the script.
    linking.urls.add(key);
    let prepared = linking.modules.get(key);
    if (!prepared) {
      prepared = this.prepareHelper(key, [...importChain, key], linking);
      linking.modules.set(key, prepared);
    }
    return prepared;
  }

  private async prepareHelper(url: string, importChain: readonly string[], linking: Linking): Promise<string> {
    const fetched = await fetchSource(this.options.fetch, url, true, importChain);
    const context = { importChain, url: fetched.url };
    let rewritten: string;
    try {
      rewritten = await rewriteModule({
        importChain,
        resolveImport: async (specifier, importerURL, chain) => {
          if (specifier === "@drawcall/glts") {
            throw new GLTSError(
              "Helpers cannot import @drawcall/glts at runtime; use import type for its types and pass values from the script",
              { ...context, phase: "resolve" },
            );
          }
          return this.prepareImport(specifier, importerURL, chain, linking);
        },
        source: compileHelper(fetched.source, context),
        sourceURL: fetched.url,
      });
    } catch (error) {
      throw toGLTSError(error, "Unable to transform helper", { ...context, phase: "transform" });
    }
    // Released with the loader; the browser keeps evaluated modules anyway.
    return this.options.moduleURLs.create(rewritten);
  }
}
