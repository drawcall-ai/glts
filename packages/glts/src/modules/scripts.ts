import type { ScriptContext } from "../scene/execution.js";
import { GLTSError, toGLTSError } from "../errors.js";
import { ExternalModules } from "./external.js";
import { canonicalize, fetchSource, type Fetch } from "./fetch.js";
import { rewriteModule } from "./rewrite.js";
import { ModuleBridge } from "./bridge.js";
import { compileHelper, compileScript } from "./compiler.js";
import { assertScriptImport, helperURL } from "./resolution.js";
import type { GLTSModules } from "../types.js";

export interface CompiledScript {
  readonly url: string;
  /** The module source with its imports linked; `@drawcall/glts` stays a token each execution binds. */
  readonly source: string;
}

/** The helpers of one script source being prepared. */
interface Linking {
  /** Helper module URLs by helper URL, so each helper has one instance per script source. */
  readonly modules: Map<string, Promise<string>>;
  /** Every helper URL the script has ever imported. */
  readonly urls: Set<string>;
}

export class ScriptModules {
  readonly #fetch: Fetch;
  readonly #bridge: ModuleBridge;
  readonly #external: ExternalModules;
  readonly #scriptCache = new Map<string, Promise<CompiledScript>>();
  /** Every helper URL a script has imported, by script URL. */
  readonly #scriptHelpers = new Map<string, Set<string>>();

  constructor({ cdnURL, fetch, modules }: { readonly cdnURL: URL; readonly fetch: Fetch; readonly modules?: GLTSModules | undefined }) {
    this.#fetch = fetch;
    this.#bridge = new ModuleBridge(modules);
    this.#external = new ExternalModules({ cdnURL, fetch, bridge: this.#bridge });
  }

  /** The script at `requestedURL`, prepared once until invalidated. */
  async prepareScript(requestedURL: string): Promise<CompiledScript> {
    const cached = this.#scriptCache.get(requestedURL);
    if (cached) return cached;

    const loading = this.fetchScript(requestedURL);
    this.#scriptCache.set(requestedURL, loading);
    try {
      return await loading;
    } catch (error) {
      this.#scriptCache.delete(requestedURL);
      throw error;
    }
  }

  commitScript(requestedURL: string, script: CompiledScript): void {
    // script.url may be a redirect target; cache and lock keys use the request URL.
    this.#scriptCache.set(requestedURL, Promise.resolve(script));
  }

  invalidateScript(requestedURL: string): void {
    this.#scriptCache.delete(requestedURL);
  }

  /** The scripts that import the helper at `url`, including scripts still fetching it. */
  dependents(url: string): string[] {
    return [...this.#scriptHelpers]
      .filter(([, helpers]) => helpers.has(url))
      .map(([script]) => script);
  }

  async evaluate(script: CompiledScript, context: ScriptContext): Promise<void> {
    const contextModule = this.#bridge.createContextModule(context);
    const source = script.source.replaceAll(this.#bridge.contextToken, contextModule.url);
    const moduleURL = this.#bridge.moduleURLs.create(source);
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
      this.#bridge.moduleURLs.release(moduleURL);
      contextModule.release();
    }
  }

  /** Fetches and prepares the script at `requestedURL` past the cache; reloads commit it once their scene changes do. */
  async fetchScript(requestedURL: string): Promise<CompiledScript> {
    const { source, url } = await fetchSource(this.#fetch, requestedURL, true, [requestedURL]);
    const compiled = compileScript(source, url);
    // Never shrinks, so fixing a helper that failed, or that an older version of the script imports, reloads the script.
    const urls = this.#scriptHelpers.get(requestedURL) ?? new Set<string>();
    this.#scriptHelpers.set(requestedURL, urls);
    const linking: Linking = { modules: new Map(), urls };
    const importChain = [url];
    try {
      const linked = await rewriteModule({ source: compiled, url, importChain }, async (specifier) =>
        specifier === "@drawcall/glts" ? this.#bridge.contextToken : this.#prepareImport(specifier, url, importChain, linking));
      return { url, source: linked };
    } catch (error) {
      throw toGLTSError(error, "Unable to transform GLTS script", { importChain, phase: "transform", url });
    }
  }

  async #prepareImport(
    specifier: string,
    importerURL: string,
    importChain: readonly string[],
    linking: Linking,
  ): Promise<string> {
    const url = helperURL(specifier, importerURL);
    if (!url) {
      assertScriptImport(specifier, importerURL, importChain);
      return this.#external.prepareImport(specifier, importerURL, importChain);
    }

    const key = canonicalize(url);
    if (importChain.includes(key)) {
      throw new GLTSError("Cyclic helper imports are not supported", {
        importChain: [...importChain, key],
        phase: "resolve",
        url: key,
      });
    }

    // Recorded before the fetch, so a change from here on reloads the script.
    linking.urls.add(key);
    let prepared = linking.modules.get(key);
    if (!prepared) {
      prepared = this.#prepareHelper(key, [...importChain, key], linking);
      linking.modules.set(key, prepared);
    }
    return prepared;
  }

  async #prepareHelper(url: string, importChain: readonly string[], linking: Linking): Promise<string> {
    const fetched = await fetchSource(this.#fetch, url, true, importChain);
    let rewritten: string;
    try {
      const source = compileHelper(fetched.source, fetched.url, importChain);
      rewritten = await rewriteModule({ source, url: fetched.url, importChain }, async (specifier) => {
        if (specifier === "@drawcall/glts") {
          throw new GLTSError(
            "Helpers cannot import runtime values from @drawcall/glts; pass them from the script",
            { importChain, phase: "resolve", url: fetched.url },
          );
        }
        return this.#prepareImport(specifier, fetched.url, importChain, linking);
      });
    } catch (error) {
      throw toGLTSError(error, "Unable to transform helper", { importChain, phase: "transform", url: fetched.url });
    }
    // Released with the loader; the browser keeps evaluated modules anyway.
    return this.#bridge.moduleURLs.create(rewritten);
  }

  dispose(): void {
    this.#bridge.dispose();
  }
}
