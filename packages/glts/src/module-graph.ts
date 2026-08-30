import { readAssetExports, type PreviewState } from "./asset-exports.js";
import { compileTypeScript } from "./compiler.js";
import { GLTSError, toGLTSError } from "./errors.js";
import { ModuleURLStore } from "./module-url-store.js";
import { rewriteModule } from "./rewrite-module.js";
import type { WrapperRuntime } from "./runtime.js";
import type { GLTSFetch, RawAssetConstructor } from "./types.js";

export interface PreparedAsset extends PreviewState {
  readonly assetClass: RawAssetConstructor;
  readonly dependencies: ReadonlySet<string>;
  readonly url: string;
}

interface FetchedSource {
  readonly source: string;
  readonly url: string;
}

interface ModuleGraphOptions {
  readonly cdnURL: URL;
  readonly fetch: GLTSFetch;
  readonly moduleURLs: ModuleURLStore;
  readonly runtime: WrapperRuntime;
  readonly threeRevision: string;
}

function hasScheme(specifier: string): boolean {
  return /^[A-Za-z][A-Za-z\d+.-]*:/.test(specifier);
}

function isBareSpecifier(specifier: string): boolean {
  return !specifier.startsWith(".") && !specifier.startsWith("/") && !hasScheme(specifier);
}

function isThreeFamilySpecifier(specifier: string): boolean {
  return specifier.startsWith("three/addons/") || specifier.startsWith("three/examples/");
}

function isGLTSURL(url: URL): boolean {
  return url.pathname.endsWith(".glts");
}

function shouldTransformExternalURL(url: URL): boolean {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return false;
  }

  const lastSegment = url.pathname.split("/").at(-1) ?? "";
  if (!lastSegment.includes(".")) {
    return true;
  }

  return /\.(?:cjs|js|mjs)$/.test(lastSegment);
}

function canonicalize(url: URL): string {
  const canonical = new URL(url);
  canonical.hash = "";
  return canonical.href;
}

async function importModule(moduleURL: string): Promise<unknown> {
  return import(/* @vite-ignore */ moduleURL);
}

export class ModuleGraph {
  readonly #cdnURL: URL;
  readonly #fetch: GLTSFetch;
  readonly #moduleURLs: ModuleURLStore;
  readonly #runtime: WrapperRuntime;
  readonly #threeRevision: string;
  readonly #currentAssets = new Map<string, PreparedAsset>();
  readonly #inactiveAssets = new Set<string>();
  readonly #rootReferences = new Map<string, number>();
  readonly #assetRevisions = new Map<string, Map<string, PreparedAsset>>();
  readonly #assetLoads = new Map<string, Promise<PreparedAsset>>();
  readonly #externalModules = new Map<string, string>();
  readonly #externalLoads = new Map<string, Promise<string>>();

  constructor(options: ModuleGraphOptions) {
    this.#cdnURL = options.cdnURL;
    this.#fetch = options.fetch;
    this.#moduleURLs = options.moduleURLs;
    this.#runtime = options.runtime;
    this.#threeRevision = options.threeRevision;
  }

  hasAsset(url: string): boolean {
    return this.#reachableAssets().has(url);
  }

  settleReachability(): void {
    const reachable = this.#reachableAssets();
    for (const url of this.#currentAssets.keys()) {
      if (reachable.has(url)) {
        this.#inactiveAssets.delete(url);
      } else {
        this.#inactiveAssets.add(url);
      }
    }
  }

  retainRoot(url: string): void {
    this.#rootReferences.set(url, (this.#rootReferences.get(url) ?? 0) + 1);
    this.settleReachability();
  }

  releaseRoot(url: string): void {
    const references = this.#rootReferences.get(url);
    if (references === undefined) {
      throw new Error(`Cannot release untracked GLTS root: ${url}`);
    }

    if (references === 1) {
      this.#rootReferences.delete(url);
    } else {
      this.#rootReferences.set(url, references - 1);
    }

    this.settleReachability();
  }

  #reachableAssets(): Set<string> {
    const pending = [...this.#rootReferences.keys()];
    const reachable = new Set<string>();

    while (pending.length > 0) {
      const candidate = pending.pop();
      if (!candidate || reachable.has(candidate)) {
        continue;
      }

      reachable.add(candidate);
      const prepared = this.#currentAssets.get(candidate);
      if (prepared) {
        pending.push(...prepared.dependencies);
      }
    }

    return reachable;
  }

  async prepareAsset(
    url: string,
    options: { readonly activate: boolean; readonly force: boolean },
    importChain: readonly string[] = []
  ): Promise<PreparedAsset> {
    if (importChain.includes(url)) {
      throw new GLTSError("Cyclic GLTS imports are not supported", {
        url,
        phase: "resolve",
        importChain: [...importChain, url]
      });
    }

    const reactivate = this.#inactiveAssets.has(url);
    const refresh = options.force || reactivate;
    const current = this.#currentAssets.get(url);
    if (current && !refresh) {
      return current;
    }

    const nextImportChain = [...importChain, url];
    const loadKey = `${refresh ? "reload" : "load"}:${url}`;
    let loading = this.#assetLoads.get(loadKey);
    if (!loading) {
      loading = this.#prepareAssetRevision(url, refresh, nextImportChain);
      this.#assetLoads.set(loadKey, loading);
      void loading.finally(() => {
        if (this.#assetLoads.get(loadKey) === loading) {
          this.#assetLoads.delete(loadKey);
        }
      }).catch(() => undefined);
    }

    const prepared = await loading;
    if (reactivate) {
      await Promise.all([...prepared.dependencies].map((dependency) =>
        this.prepareAsset(dependency, { activate: true, force: false }, nextImportChain)
      ));
    }
    if (options.activate) {
      this.activateAsset(prepared);
    }
    return prepared;
  }

  activateAsset(prepared: PreparedAsset): void {
    this.#runtime.setAssetClass(prepared.url, prepared.assetClass);
    this.#currentAssets.set(prepared.url, prepared);
    this.#inactiveAssets.delete(prepared.url);
  }

  async #prepareAssetRevision(
    url: string,
    force: boolean,
    importChain: readonly string[]
  ): Promise<PreparedAsset> {
    const fetched = await this.#fetchSource(url, force, importChain);
    const revisions = this.#assetRevisions.get(url);
    const cached = revisions?.get(fetched.source);
    if (cached) {
      return cached;
    }

    let compiled: string;
    try {
      compiled = compileTypeScript(fetched.source);
    } catch (error) {
      throw toGLTSError(error, "Unable to compile TypeScript asset", {
        url,
        phase: "transform",
        importChain
      });
    }

    const dependencies = new Set<string>();
    let transformed: string;
    try {
      transformed = await rewriteModule({
        source: compiled,
        sourceURL: url,
        importChain,
        resolveImport: (specifier, importerURL, chain) =>
          this.#resolveAssetImport(specifier, importerURL, chain, dependencies)
      });
    } catch (error) {
      throw toGLTSError(error, "Unable to transform asset module", {
        url,
        phase: "transform",
        importChain
      });
    }

    const moduleURL = this.#moduleURLs.create(transformed);
    let namespace: unknown;
    try {
      namespace = await importModule(moduleURL);
    } catch (error) {
      throw toGLTSError(error, "Unable to evaluate asset module", {
        url,
        phase: "evaluate",
        importChain
      });
    }

    const assetExports = readAssetExports(namespace, { url, importChain });

    const prepared: PreparedAsset = {
      dependencies,
      ...assetExports,
      url
    };
    const nextRevisions = revisions ?? new Map<string, PreparedAsset>();
    nextRevisions.set(fetched.source, prepared);
    this.#assetRevisions.set(url, nextRevisions);
    return prepared;
  }

  async #resolveAssetImport(
    specifier: string,
    importerURL: string,
    importChain: readonly string[],
    dependencies: Set<string>
  ): Promise<string> {
    if (specifier === "three") {
      return this.#runtime.threeModuleURL;
    }

    if (specifier === "@drawcall/glts/asset") {
      return this.#runtime.assetModuleURL;
    }

    if (isThreeFamilySpecifier(specifier)) {
      return this.#prepareExternal(this.#threeFamilyURL(specifier), importChain);
    }

    if (isBareSpecifier(specifier)) {
      if (specifier.startsWith("#") || specifier.startsWith("node:")) {
        throw new GLTSError(`Unsupported package import: ${specifier}`, {
          url: importerURL,
          phase: "resolve",
          importChain
        });
      }

      return this.#prepareExternal(this.#packageURL(specifier), importChain);
    }

    let resolved: URL;
    try {
      resolved = new URL(specifier, importerURL);
    } catch (error) {
      throw new GLTSError(`Unable to resolve import ${specifier}`, {
        url: importerURL,
        phase: "resolve",
        importChain
      }, error);
    }

    if (isGLTSURL(resolved)) {
      const childURL = canonicalize(resolved);
      await this.prepareAsset(childURL, { activate: true, force: false }, importChain);
      dependencies.add(childURL);
      return this.#runtime.getWrapperModuleURL(childURL);
    }

    if (resolved.protocol === "http:" || resolved.protocol === "https:") {
      if (specifier.startsWith(".") || specifier.startsWith("/")) {
        throw new GLTSError(
          `Local helper modules are not supported in V1: ${specifier}`,
          { url: importerURL, phase: "resolve", importChain }
        );
      }

      return this.#prepareExternal(resolved, importChain);
    }

    throw new GLTSError(`Unsupported import: ${specifier}`, {
      url: importerURL,
      phase: "resolve",
      importChain
    });
  }

  async #prepareExternal(url: URL, importChain: readonly string[]): Promise<string> {
    const key = canonicalize(url);
    const cached = this.#externalModules.get(key);
    if (cached) {
      return cached;
    }

    if (importChain.includes(key)) {
      throw new GLTSError("Cyclic CDN modules are not supported", {
        url: key,
        phase: "resolve",
        importChain: [...importChain, key]
      });
    }

    let loading = this.#externalLoads.get(key);
    if (!loading) {
      loading = this.#prepareExternalModule(key, [...importChain, key]);
      this.#externalLoads.set(key, loading);
      void loading.finally(() => {
        if (this.#externalLoads.get(key) === loading) {
          this.#externalLoads.delete(key);
        }
      }).catch(() => undefined);
    }

    return loading;
  }

  async #prepareExternalModule(
    requestedURL: string,
    importChain: readonly string[]
  ): Promise<string> {
    const fetched = await this.#fetchSource(requestedURL, false, importChain);
    let transformed: string;

    try {
      transformed = await rewriteModule({
        source: fetched.source,
        sourceURL: fetched.url,
        importChain,
        resolveImport: (specifier, importerURL, chain) =>
          this.#resolveExternalImport(specifier, importerURL, chain)
      });
    } catch (error) {
      throw toGLTSError(error, "Unable to transform CDN module", {
        url: fetched.url,
        phase: "transform",
        importChain
      });
    }

    const moduleURL = this.#moduleURLs.create(transformed);
    this.#externalModules.set(requestedURL, moduleURL);
    this.#externalModules.set(fetched.url, moduleURL);
    return moduleURL;
  }

  async #resolveExternalImport(
    specifier: string,
    importerURL: string,
    importChain: readonly string[]
  ): Promise<string> {
    if (specifier === "three") {
      return this.#runtime.threeModuleURL;
    }

    if (isThreeFamilySpecifier(specifier)) {
      return this.#prepareExternal(this.#threeFamilyURL(specifier), importChain);
    }

    if (isBareSpecifier(specifier)) {
      if (specifier.startsWith("#") || specifier.startsWith("node:")) {
        throw new GLTSError(`Unsupported CDN package import: ${specifier}`, {
          url: importerURL,
          phase: "resolve",
          importChain
        });
      }

      return this.#prepareExternal(this.#packageURL(specifier), importChain);
    }

    const resolved = new URL(specifier, importerURL);
    if (!shouldTransformExternalURL(resolved)) {
      return resolved.href;
    }

    return this.#prepareExternal(resolved, importChain);
  }

  #packageURL(specifier: string): URL {
    const url = new URL(specifier, this.#cdnURL);
    const separator = url.search ? "&" : "?";
    return new URL(`${url.href}${separator}bundle&external=three&target=es2022`);
  }

  #threeFamilyURL(specifier: string): URL {
    const path = specifier.startsWith("three/addons/")
      ? `examples/jsm/${specifier.slice("three/addons/".length)}`
      : specifier.slice("three/".length);
    return this.#packageURL(`three@0.${this.#threeRevision}.0/${path}`);
  }

  async #fetchSource(
    url: string,
    bypassCache: boolean,
    importChain: readonly string[]
  ): Promise<FetchedSource> {
    let response: Response;
    try {
      response = await this.#fetch(url, { cache: bypassCache ? "no-cache" : "default" });
    } catch (error) {
      throw new GLTSError("Network request failed", {
        url,
        phase: "fetch",
        importChain
      }, error);
    }

    if (!response.ok) {
      throw new GLTSError(`Request failed with ${response.status} ${response.statusText}`, {
        url,
        phase: "fetch",
        importChain
      });
    }

    try {
      return {
        source: await response.text(),
        url: canonicalize(new URL(response.url || url))
      };
    } catch (error) {
      throw new GLTSError("Unable to read response body", {
        url,
        phase: "fetch",
        importChain
      }, error);
    }
  }
}

export function canonicalGLTSURL(input: string | URL, baseURL: URL): string {
  return canonicalize(new URL(input, baseURL));
}
