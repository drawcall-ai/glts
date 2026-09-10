import type { ScriptContext } from "../scene/execution.js";
import type { FetchedSource } from "./fetch.js";
import { GLTSError, toGLTSError } from "../errors.js";
import { canonicalize, fetchSource } from "./fetch.js";
import type { ModuleURLStore } from "./urls.js";
import { rewriteModule } from "./rewrite.js";
import { resolveModuleURL, type ImportSource } from "./resolution.js";
import type { ModuleBridge } from "./bridge.js";
import type { GLTSFetch } from "../types.js";

export interface ExternalModule {
  readonly url: string;
  readonly physics: boolean;
}

interface SharedModules {
  readonly sources: Map<string, Promise<FetchedSource>>;
  readonly plain: Map<string, ExternalModule>;
}

interface ExternalModulesOptions {
  readonly cdnURL: URL;
  readonly fetch: GLTSFetch;
  readonly moduleURLs: ModuleURLStore;
  readonly bridge: ModuleBridge;
  readonly threeRevision: string;
}

export class ExternalModules {
  readonly #options: ExternalModulesOptions;
  readonly #shared: SharedModules;
  readonly #context: ScriptContext | undefined;
  readonly #modules = new Map<string, ExternalModule>();

  constructor(
    options: ExternalModulesOptions,
    context?: ScriptContext,
    shared: SharedModules = { sources: new Map(), plain: new Map() },
  ) {
    this.#options = options;
    this.#context = context;
    this.#shared = shared;
  }

  forContext(context: ScriptContext): ExternalModules {
    return new ExternalModules(this.#options, context, this.#shared);
  }

  async prepareImport(
    specifier: string,
    importerURL: string,
    importChain: readonly string[],
    source: ImportSource = "module",
  ): Promise<ExternalModule> {
    if (specifier === "three") {
      return { url: this.#options.bridge.threeModuleURL, physics: false };
    }
    if (specifier === "@drawcall/physics") {
      if (!this.#context) throw new Error("Physics modules require an execution context");
      return {
        url: await this.#options.bridge.getPhysicsModuleURL(this.#context),
        physics: true,
      };
    }

    const { url, transform } = resolveModuleURL(
      specifier, importerURL, importChain, this.#options, source,
    );
    return transform ? this.#prepare(url, importChain) : { url: url.href, physics: false };
  }

  async #prepare(
    url: URL,
    importChain: readonly string[],
  ): Promise<ExternalModule> {
    const key = canonicalize(url);
    const cached = this.#modules.get(key) ?? this.#shared.plain.get(key);
    if (cached) {
      return cached;
    }

    if (importChain.includes(key)) {
      throw new GLTSError("Cyclic CDN modules are not supported", {
        importChain: [...importChain, key],
        phase: "resolve",
        url: key,
      });
    }

    return this.#load(key, [...importChain, key]);
  }

  async #load(
    requestedURL: string,
    importChain: readonly string[],
  ): Promise<ExternalModule> {
    let source = this.#shared.sources.get(requestedURL);
    if (!source) {
      source = fetchSource(this.#options.fetch, requestedURL, false, importChain);
      this.#shared.sources.set(requestedURL, source);
      void source.catch(() => this.#shared.sources.delete(requestedURL));
    }
    const fetched = await source;
    const cached = this.#modules.get(fetched.url) ?? this.#shared.plain.get(fetched.url);
    if (cached) {
      this.#modules.set(requestedURL, cached);
      return cached;
    }

    let transformed: string;
    let physics = false;
    try {
      transformed = await rewriteModule({
        importChain,
        resolveImport: async (specifier, importerURL, chain) => {
          const dependency = await this.prepareImport(specifier, importerURL, chain);
          physics ||= dependency.physics;
          return dependency.url;
        },
        source: fetched.source,
        sourceURL: fetched.url,
      });
    } catch (error) {
      throw toGLTSError(error, "Unable to transform CDN module", {
        importChain,
        phase: "transform",
        url: fetched.url,
      });
    }

    if (!physics) {
      const cached =
        this.#shared.plain.get(requestedURL) ??
        this.#shared.plain.get(fetched.url);
      if (cached) return cached;
    }
    const moduleURL = this.#options.moduleURLs.create(transformed);
    if (physics)
      this.#context?.onDispose(() => this.#options.moduleURLs.release(moduleURL));
    const module = { url: moduleURL, physics };
    this.#modules.set(requestedURL, module);
    this.#modules.set(fetched.url, module);
    if (!physics) {
      this.#shared.plain.set(requestedURL, module);
      this.#shared.plain.set(fetched.url, module);
    }
    return module;
  }
}
