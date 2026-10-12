import { REVISION } from "three";

import { GLTSError, toGLTSError } from "../errors.js";
import { canonicalize, fetchSource, type Fetch, type FetchedSource } from "./fetch.js";
import { rewriteModule } from "./rewrite.js";
import { isBareSpecifier, packageURL } from "./resolution.js";
import type { ModuleBridge } from "./bridge.js";
import type { ModuleURLStore } from "./urls.js";

/** The CDN path of a package, pinning both Three addon spellings to the host's revision. */
function packagePath(specifier: string): string {
  if (specifier.startsWith("three/addons/")) {
    return `three@0.${REVISION}.0/examples/jsm/${specifier.slice("three/addons/".length)}`;
  }
  if (specifier.startsWith("three/examples/")) {
    return `three@0.${REVISION}.0/${specifier.slice("three/".length)}`;
  }
  return specifier;
}

/** Host modules and CDN modules shared by every script of one loader, keyed by URL. */
export class ExternalModules {
  readonly #cdnURL: URL;
  readonly #fetch: Fetch;
  readonly #bridge: ModuleBridge;
  readonly #urls: ModuleURLStore;
  readonly #sources = new Map<string, Promise<FetchedSource>>();
  readonly #modules = new Map<string, string>();

  constructor({ cdnURL, fetch, bridge, urls }: {
    readonly cdnURL: URL;
    readonly fetch: Fetch;
    readonly bridge: ModuleBridge;
    readonly urls: ModuleURLStore;
  }) {
    this.#cdnURL = cdnURL;
    this.#fetch = fetch;
    this.#bridge = bridge;
    this.#urls = urls;
  }

  /** Resolves an import to the URL of a module scripts can import. */
  async linkImport(specifier: string, importerURL: string, importChain: readonly string[]): Promise<string> {
    const host = this.#bridge.getHostModuleURL(specifier);
    if (host) return host;
    if (specifier.startsWith("#")) {
      throw new GLTSError(`Unsupported CDN package import: ${specifier}`, { importChain, phase: "resolve", url: importerURL });
    }

    const url = isBareSpecifier(specifier)
      ? packageURL(packagePath(specifier), this.#cdnURL, this.#bridge.hostSpecifiers)
      : new URL(specifier, importerURL);
    if (url.protocol !== "http:" && url.protocol !== "https:") return url.href;
    return this.#load(canonicalize(url), importChain);
  }

  async #load(requestedURL: string, importerChain: readonly string[]): Promise<string> {
    const cached = this.#modules.get(requestedURL);
    if (cached) return cached;

    const importChain = [...importerChain, requestedURL];
    if (importerChain.includes(requestedURL)) {
      throw new GLTSError("Cyclic CDN modules are not supported", { importChain, phase: "resolve", url: requestedURL });
    }

    let source = this.#sources.get(requestedURL);
    if (!source) {
      source = fetchSource(this.#fetch, requestedURL, false, importChain);
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
      transformed = await rewriteModule(
        { ...fetched, importChain },
        (specifier) => this.linkImport(specifier, fetched.url, importChain),
      );
    } catch (error) {
      throw toGLTSError(error, "Unable to transform CDN module", { importChain, phase: "transform", url: fetched.url });
    }

    // A concurrent import of the same module may have finished first.
    const concurrent = this.#modules.get(requestedURL) ?? this.#modules.get(fetched.url);
    if (concurrent) return concurrent;
    const moduleURL = this.#urls.create(transformed);
    this.#modules.set(requestedURL, moduleURL);
    this.#modules.set(fetched.url, moduleURL);
    return moduleURL;
  }
}
