import { REVISION } from "three";

import { GLTSError, toGLTSError } from "../errors.js";
import { canonicalize, fetchSource, type Fetch, type FetchedSource } from "./fetch.js";
import { rewriteModule } from "./rewrite.js";
import { hasVersion, isBareSpecifier, packageURL } from "./resolution.js";
import type { ModuleBridge } from "./bridge.js";
import type { GLTSResolve } from "../types.js";
import { moduleURL } from "./urls.js";

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
  readonly #resolve: GLTSResolve | undefined;
  readonly #sources = new Map<string, Promise<FetchedSource>>();
  readonly #modules = new Map<string, string>();

  constructor({ cdnURL, fetch, bridge, resolve }: {
    readonly cdnURL: URL;
    readonly fetch: Fetch;
    readonly bridge: ModuleBridge;
    readonly resolve?: GLTSResolve | undefined;
  }) {
    this.#cdnURL = cdnURL;
    this.#fetch = fetch;
    this.#bridge = bridge;
    this.#resolve = resolve;
  }

  /** Resolves an import to the URL of a module scripts can import. */
  async linkImport(specifier: string, importerURL: string, importChain: readonly string[]): Promise<string> {
    const host = this.#bridge.getHostModuleURL(specifier);
    if (host) return host;
    if (specifier.startsWith("#")) {
      throw new GLTSError(`Unsupported CDN package import: ${specifier}`, { importChain, phase: "resolve", url: importerURL });
    }

    const bare = isBareSpecifier(specifier);
    // Scripts share the host's package instances; the host imports the resolved URL natively.
    if (bare && this.#resolve && !hasVersion(specifier)) {
      try {
        return this.#resolve(specifier);
      } catch (error) {
        throw new GLTSError(`Unable to resolve ${specifier} from the host`, { importChain, phase: "resolve", url: importerURL }, error);
      }
    }

    const url = bare
      ? packageURL(packagePath(specifier), this.#cdnURL, this.#bridge.hostSpecifiers)
      : new URL(specifier, importerURL);
    const peer = this.#peerName(specifier, url);
    if (peer) return this.linkImport(peer, importerURL, importChain);
    if (url.protocol !== "http:" && url.protocol !== "https:") return url.href;
    return this.#load(canonicalize(url), importChain);
  }

  /**
   * The package a CDN bundle imports as a peer, which the CDN writes as an unbundled root path such as
   * `/pkg@^1.0.0?external=three`. Linked by name instead, it shares the script's or host's instance.
   */
  #peerName(specifier: string, url: URL): string | undefined {
    const cdn = this.#cdnURL;
    if (!specifier.startsWith("/") || url.origin !== cdn.origin || !url.pathname.startsWith(cdn.pathname)) return;
    if (url.searchParams.has("bundle")) return;
    const path = url.pathname.slice(cdn.pathname.length);
    return /^((?:@[^/]+\/)?[^/@]+)@[^/]+$/.exec(path)?.[1];
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
      const link = (specifier: string) => this.linkImport(specifier, fetched.url, importChain);
      transformed = await rewriteModule({ ...fetched, importChain }, link, () => this.#bridge.importFunction(fetched.url, link));
    } catch (error) {
      throw toGLTSError(error, "Unable to transform CDN module", { importChain, phase: "transform", url: fetched.url });
    }

    // A concurrent import of the same module may have finished first.
    const concurrent = this.#modules.get(requestedURL) ?? this.#modules.get(fetched.url);
    if (concurrent) return concurrent;
    const url = moduleURL(transformed);
    this.#modules.set(requestedURL, url);
    this.#modules.set(fetched.url, url);
    return url;
  }
}
