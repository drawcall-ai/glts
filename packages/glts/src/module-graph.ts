import { compileTypeScript } from "./compiler.js";
import type { ScriptContext } from "./execution.js";
import { GLTSError, toGLTSError } from "./errors.js";
import {
  ExternalModules,
  isBareSpecifier,
  isThreeFamilySpecifier
} from "./external-modules.js";
import { canonicalize, fetchSource } from "./fetch-source.js";
import { ModuleURLStore } from "./module-url-store.js";
import { rewriteModule } from "./rewrite-module.js";
import { ModuleRuntime } from "./runtime.js";
import { validateScript } from "./script.js";
import type { GLTSFetch } from "./types.js";

export interface PreparedScript {
  readonly source: string;
  readonly url: string;
}

interface ModuleGraphOptions {
  readonly cdnURL: URL;
  readonly fetch: GLTSFetch;
  readonly moduleURLs: ModuleURLStore;
  readonly runtime: ModuleRuntime;
  readonly threeRevision: string;
}

function isGLTSURL(url: URL): boolean {
  return url.pathname.endsWith(".glts");
}

async function importModule(moduleURL: string): Promise<unknown> {
  return import(/* @vite-ignore */ moduleURL);
}

export class ModuleGraph {
  readonly #external: ExternalModules;
  readonly #fetch: GLTSFetch;
  readonly #moduleURLs: ModuleURLStore;
  readonly #runtime: ModuleRuntime;
  readonly #scriptLoads = new Map<string, Promise<PreparedScript>>();
  readonly #scripts = new Map<string, PreparedScript>();

  constructor(options: ModuleGraphOptions) {
    this.#fetch = options.fetch;
    this.#moduleURLs = options.moduleURLs;
    this.#runtime = options.runtime;
    this.#external = new ExternalModules(options);
  }

  async prepare(url: string, force: boolean): Promise<PreparedScript> {
    const cached = this.#scripts.get(url);
    if (cached && !force) {
      return cached;
    }

    const key = `${force ? "reload" : "load"}:${url}`;
    let loading = this.#scriptLoads.get(key);
    if (!loading) {
      loading = this.#prepare(url, force);
      this.#scriptLoads.set(key, loading);
      void loading.finally(() => {
        if (this.#scriptLoads.get(key) === loading) {
          this.#scriptLoads.delete(key);
        }
      }).catch(() => undefined);
    }
    return loading;
  }

  activate(url: string, script: PreparedScript): void {
    this.#scripts.set(url, script);
    this.#scripts.set(script.url, script);
  }

  async execute(script: PreparedScript, context: ScriptContext): Promise<void> {
    const contextModule = this.#runtime.contextModule(context);
    let transformed: string;
    try {
      transformed = await rewriteModule({
        importChain: [script.url],
        resolveImport: (specifier, importerURL, chain) =>
          this.#resolveImport(specifier, importerURL, chain, contextModule.url),
        source: script.source,
        sourceURL: script.url
      });
    } catch (error) {
      contextModule.release();
      throw toGLTSError(error, "Unable to transform GLTS script", {
        importChain: [script.url],
        phase: "transform",
        url: script.url
      });
    }

    const moduleURL = this.#moduleURLs.create(transformed);
    try {
      await importModule(moduleURL);
    } catch (error) {
      throw toGLTSError(error, "Unable to execute GLTS script", {
        importChain: [script.url],
        phase: "evaluate",
        url: script.url
      });
    } finally {
      this.#moduleURLs.release(moduleURL);
      contextModule.release();
    }
  }

  async #prepare(url: string, force: boolean): Promise<PreparedScript> {
    const fetched = await fetchSource(this.#fetch, url, force, [url]);
    try {
      validateScript(fetched.source, {
        importChain: [fetched.url],
        url: fetched.url
      });
    } catch (error) {
      throw toGLTSError(error, "Invalid GLTS script", {
        importChain: [fetched.url],
        phase: "transform",
        url: fetched.url
      });
    }

    let source: string;
    try {
      source = compileTypeScript(fetched.source);
    } catch (error) {
      throw toGLTSError(error, "Unable to compile TypeScript script", {
        importChain: [fetched.url],
        phase: "transform",
        url: fetched.url
      });
    }

    const script = { source, url: fetched.url };
    if (!force) {
      this.activate(url, script);
    }
    return script;
  }

  async #resolveImport(
    specifier: string,
    importerURL: string,
    importChain: readonly string[],
    contextModuleURL: string
  ): Promise<string> {
    if (specifier === "three") {
      return this.#runtime.threeModuleURL;
    }

    if (specifier === "@drawcall/glts") {
      return contextModuleURL;
    }

    if (isThreeFamilySpecifier(specifier)) {
      return this.#external.threeFamily(specifier, importChain);
    }

    if (isBareSpecifier(specifier)) {
      if (specifier.startsWith("#") || specifier.startsWith("node:")) {
        throw new GLTSError(`Unsupported package import: ${specifier}`, {
          importChain,
          phase: "resolve",
          url: importerURL
        });
      }
      return this.#external.package(specifier, importChain);
    }

    const resolved = new URL(specifier, importerURL);
    if (isGLTSURL(resolved)) {
      throw new GLTSError(
        `Static GLTS imports are not supported: ${specifier}; use gltsLoader.loadAsync()`,
        { importChain, phase: "resolve", url: importerURL }
      );
    }

    if (
      (resolved.protocol === "http:" || resolved.protocol === "https:") &&
      !specifier.startsWith(".") &&
      !specifier.startsWith("/")
    ) {
      return this.#external.url(resolved, importChain);
    }

    throw new GLTSError(`Unsupported local import: ${specifier}`, {
      importChain,
      phase: "resolve",
      url: importerURL
    });
  }
}

export function canonicalGLTSURL(input: string | URL, baseURL: URL): string {
  return canonicalize(new URL(input, baseURL));
}
