import type { FetchedSource } from "./fetch.js";
import { GLTSError, toGLTSError } from "../errors.js";
import { canonicalize, fetchSource } from "./fetch.js";
import type { ModuleURLStore } from "./urls.js";
import { rewriteModule } from "./rewrite.js";
import { resolveModuleURL, type ImportSource } from "./resolution.js";
import type { ModuleBridge } from "./bridge.js";
import type { GLTSFetch } from "../types.js";

interface ExternalModulesOptions {
  readonly cdnURL: URL;
  readonly fetch: GLTSFetch;
  readonly moduleURLs: ModuleURLStore;
  readonly bridge: ModuleBridge;
  readonly threeRevision: string;
}

/** Host modules and CDN modules shared by every script of one loader, keyed by URL. */
export class ExternalModules {
  readonly #options: ExternalModulesOptions;
  readonly #sources = new Map<string, Promise<FetchedSource>>();
  readonly #modules = new Map<string, string>();

  constructor(options: ExternalModulesOptions) {
    this.#options = options;
  }

  /** Resolves an import to the URL of a module scripts can import. */
  async prepareImport(
    specifier: string,
    importerURL: string,
    importChain: readonly string[],
    source: ImportSource = "module",
  ): Promise<string> {
    const { bridge } = this.#options;
    const host = bridge.getHostModuleURL(specifier);
    if (host) return host;

    const { url, transform } = resolveModuleURL(specifier, importerURL, importChain, {
      cdnURL: this.#options.cdnURL,
      threeRevision: this.#options.threeRevision,
      external: bridge.hostSpecifiers,
    }, source);
    return transform ? this.#prepare(url, importChain) : url.href;
  }

  async #prepare(url: URL, importChain: readonly string[]): Promise<string> {
    const key = canonicalize(url);
    const cached = this.#modules.get(key);
    if (cached) return cached;

    if (importChain.includes(key)) {
      throw new GLTSError("Cyclic CDN modules are not supported", {
        importChain: [...importChain, key],
        phase: "resolve",
        url: key,
      });
    }

    return this.#load(key, [...importChain, key]);
  }

  async #load(requestedURL: string, importChain: readonly string[]): Promise<string> {
    let source = this.#sources.get(requestedURL);
    if (!source) {
      source = fetchSource(this.#options.fetch, requestedURL, false, importChain);
      this.#sources.set(requestedURL, source);
      void source.catch(() => this.#sources.delete(requestedURL));
    }
    const fetched = await source;
    const redirected = this.#modules.get(fetched.url);
    if (redirected) {
      this.#modules.set(requestedURL, redirected);
      return redirected;
    }

    let transformed: string;
    try {
      transformed = await rewriteModule({
        importChain,
        resolveImport: (specifier, importerURL, chain) =>
          this.prepareImport(specifier, importerURL, chain),
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

    // A concurrent import of the same module may have finished first.
    const concurrent = this.#modules.get(requestedURL) ?? this.#modules.get(fetched.url);
    if (concurrent) return concurrent;
    const moduleURL = this.#options.moduleURLs.create(transformed);
    this.#modules.set(requestedURL, moduleURL);
    this.#modules.set(fetched.url, moduleURL);
    return moduleURL;
  }
}
