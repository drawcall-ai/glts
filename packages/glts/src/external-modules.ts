import { GLTSError, toGLTSError } from "./errors.js";
import { canonicalize, fetchSource } from "./fetch-source.js";
import { ModuleURLStore } from "./module-url-store.js";
import { rewriteModule } from "./rewrite-module.js";
import { ModuleRuntime } from "./runtime.js";
import type { GLTSFetch } from "./types.js";

interface ExternalModulesOptions {
  readonly cdnURL: URL;
  readonly fetch: GLTSFetch;
  readonly moduleURLs: ModuleURLStore;
  readonly runtime: ModuleRuntime;
  readonly threeRevision: string;
}

export function hasScheme(specifier: string): boolean {
  return /^[A-Za-z][A-Za-z\d+.-]*:/.test(specifier);
}

export function isBareSpecifier(specifier: string): boolean {
  return !specifier.startsWith(".") && !specifier.startsWith("/") && !hasScheme(specifier);
}

export function isThreeFamilySpecifier(specifier: string): boolean {
  return specifier.startsWith("three/addons/") || specifier.startsWith("three/examples/");
}

function shouldTransform(url: URL): boolean {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return false;
  }

  const lastSegment = url.pathname.split("/").at(-1) ?? "";
  return !lastSegment.includes(".") || /\.(?:cjs|js|mjs)$/.test(lastSegment);
}

export class ExternalModules {
  readonly #cdnURL: URL;
  readonly #fetch: GLTSFetch;
  readonly #loads = new Map<string, Promise<string>>();
  readonly #moduleURLs: ModuleURLStore;
  readonly #modules = new Map<string, string>();
  readonly #runtime: ModuleRuntime;
  readonly #threeRevision: string;

  constructor(options: ExternalModulesOptions) {
    this.#cdnURL = options.cdnURL;
    this.#fetch = options.fetch;
    this.#moduleURLs = options.moduleURLs;
    this.#runtime = options.runtime;
    this.#threeRevision = options.threeRevision;
  }

  package(specifier: string, importChain: readonly string[]): Promise<string> {
    return this.#prepare(this.#packageURL(specifier), importChain);
  }

  threeFamily(specifier: string, importChain: readonly string[]): Promise<string> {
    const path = specifier.startsWith("three/addons/")
      ? `examples/jsm/${specifier.slice("three/addons/".length)}`
      : specifier.slice("three/".length);
    return this.#prepare(
      this.#packageURL(`three@0.${this.#threeRevision}.0/${path}`),
      importChain
    );
  }

  url(url: URL, importChain: readonly string[]): Promise<string> {
    return this.#prepare(url, importChain);
  }

  async #prepare(url: URL, importChain: readonly string[]): Promise<string> {
    const key = canonicalize(url);
    const cached = this.#modules.get(key);
    if (cached) {
      return cached;
    }

    if (importChain.includes(key)) {
      throw new GLTSError("Cyclic CDN modules are not supported", {
        importChain: [...importChain, key],
        phase: "resolve",
        url: key
      });
    }

    let loading = this.#loads.get(key);
    if (!loading) {
      loading = this.#load(key, [...importChain, key]);
      this.#loads.set(key, loading);
      void loading.finally(() => {
        if (this.#loads.get(key) === loading) {
          this.#loads.delete(key);
        }
      }).catch(() => undefined);
    }
    return loading;
  }

  async #load(requestedURL: string, importChain: readonly string[]): Promise<string> {
    const fetched = await fetchSource(this.#fetch, requestedURL, false, importChain);
    let transformed: string;
    try {
      transformed = await rewriteModule({
        importChain,
        resolveImport: (specifier, importerURL, chain) =>
          this.#resolve(specifier, importerURL, chain),
        source: fetched.source,
        sourceURL: fetched.url
      });
    } catch (error) {
      throw toGLTSError(error, "Unable to transform CDN module", {
        importChain,
        phase: "transform",
        url: fetched.url
      });
    }

    const moduleURL = this.#moduleURLs.create(transformed);
    this.#modules.set(requestedURL, moduleURL);
    this.#modules.set(fetched.url, moduleURL);
    return moduleURL;
  }

  async #resolve(
    specifier: string,
    importerURL: string,
    importChain: readonly string[]
  ): Promise<string> {
    if (specifier === "three") {
      return this.#runtime.threeModuleURL;
    }

    if (isThreeFamilySpecifier(specifier)) {
      return this.threeFamily(specifier, importChain);
    }

    if (isBareSpecifier(specifier)) {
      if (specifier.startsWith("#") || specifier.startsWith("node:")) {
        throw new GLTSError(`Unsupported CDN package import: ${specifier}`, {
          importChain,
          phase: "resolve",
          url: importerURL
        });
      }
      return this.package(specifier, importChain);
    }

    const resolved = new URL(specifier, importerURL);
    return shouldTransform(resolved)
      ? this.#prepare(resolved, importChain)
      : resolved.href;
  }

  #packageURL(specifier: string): URL {
    const url = new URL(specifier, this.#cdnURL);
    const separator = url.search ? "&" : "?";
    return new URL(`${url.href}${separator}bundle&external=three&target=es2022`);
  }
}
