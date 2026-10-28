import { REVISION } from "three";

import { Dependencies } from "../dependencies.js";
import { GLTSError, toGLTSError } from "../errors.js";
import { gltsSpecifier } from "../imports.js";
import type { GLTSLoaderOptions, GLTSModules, GLTSResolve } from "../types.js";
import { canonicalize, moduleURL } from "../urls.js";
import { Bridge } from "./bridge.js";
import { linkOnce, type Entry, type Link } from "./cache.js";
import { compileHelper, compileScript } from "./compile.js";
import { fetchSource, type Fetch, type Source } from "./fetch.js";
import { cdnPackageURL, classifyImport, hasVersion, isBareSpecifier, peerName } from "./resolution.js";
import { rewriteModule } from "./rewrite.js";

/** Which file a script, helper, or package module is. */
export interface Identity {
  /** The URL it was requested by, which keys it in the linker. */
  readonly requestedURL: string;
  /** The URL it was fetched from, after redirects, which its relative imports resolve against. */
  readonly url: string;
}

/** A linked script or helper. */
export interface Script extends Identity {
  /** The URL of its module, with its imports linked. */
  readonly module: string;
  /** The files it uses, its own requested and fetched URLs included; a helper's importers include them. */
  readonly dependencies: Dependencies;
}

/** The script, helper, or package a linked module was made from; the module passes it back for each dynamic import. */
export interface Importer extends Identity {
  readonly kind: "script" | "helper" | "package";
}

/** Links scripts and their imports into modules for one loader, sharing helpers, host modules, and packages between scripts. */
export class Linker {
  readonly #cdnURL: URL;
  readonly #fetch: Fetch;
  readonly #resolve: GLTSResolve | undefined;
  readonly #bridge: Bridge;
  readonly #external: readonly string[];
  readonly #env: GLTSLoaderOptions["env"];
  /** Linked scripts, linked helpers, and package module URLs, by requested URL. */
  readonly #scripts = new Map<string, Entry<Script>>();
  readonly #helpers = new Map<string, Entry<Script>>();
  readonly #packages = new Map<string, Entry<string>>();
  /**
   * Every fetched URL of each script and helper and every helper URL it has imported, by requested URL; never
   * shrinks, so fixing a helper that failed, or that an older version imports, reloads the scripts using it, and
   * a script is found by the URL it was redirected to.
   */
  readonly #scriptHistory = new Map<string, Set<string>>();
  readonly #helperHistory = new Map<string, Set<string>>();

  constructor({ cdnURL, fetch, modules, resolve, external = [], env }: {
    readonly cdnURL: URL;
    readonly fetch: Fetch;
    /** Every namespace the host shares with scripts, by bare specifier. */
    readonly modules: GLTSModules;
    readonly resolve?: GLTSResolve | undefined;
    readonly external?: readonly string[] | undefined;
    readonly env?: GLTSLoaderOptions["env"];
  }) {
    this.#cdnURL = cdnURL;
    this.#fetch = fetch;
    this.#resolve = resolve;
    this.#bridge = new Bridge(modules, (importer, specifier, running) => this.#linkDynamic(importer, specifier, running));
    this.#external = [...this.#bridge.hostSpecifiers, ...external];
    this.#env = env === undefined ? undefined : { ...env };
  }

  /** The script at `requestedURL`, linked once until invalidated. */
  getScript(requestedURL: string): Promise<Script> {
    return linkOnce(this.#scripts, requestedURL, [], (chain, link) => this.#linkFile("script", requestedURL, chain, link));
  }

  /**
   * Forgets the script or helper at `url`, the helpers using it, and the scripts using it, including scripts still
   * fetching it, so they link fresh. Returns the scripts using it, or else `url` itself, which may be a script.
   */
  invalidate(url: string): string[] {
    for (const helper of this.#helpers.keys()) {
      if (this.#uses([helper], url)) this.#helpers.delete(helper);
    }
    const users = [...this.#scriptHistory].filter(([, helpers]) => this.#uses(helpers, url)).map(([script]) => script);
    const scripts = users.length > 0 ? users : [url];
    for (const script of scripts) this.#scripts.delete(script);
    return scripts;
  }

  dispose(): void {
    this.#bridge.dispose();
  }

  /** Links the script or helper at `requestedURL`, `chain` ending at it. */
  async #linkFile(kind: "script" | "helper", requestedURL: string, chain: readonly string[], link: Link): Promise<Script> {
    const fetched = await fetchSource(this.#fetch, requestedURL, true, chain);
    const identity: Identity = { requestedURL, url: fetched.url };
    const importer: Importer = { kind, ...identity };
    const dependencies = new Dependencies();
    dependencies.add(requestedURL, fetched.url);
    this.#addToHistory(importer, fetched.url);
    const script = kind === "script";
    const source = script ? compileScript(fetched.source, fetched.url) : compileHelper(fetched.source, fetched.url, chain);
    const linked = await this.#linkModule(
      { source, url: fetched.url },
      importer,
      // A script's chain starts at the URL it was fetched from.
      script ? [fetched.url] : chain,
      dependencies,
      script ? "Unable to link GLTS script" : "Unable to link helper",
      link,
    );
    return { ...identity, module: moduleURL(linked), dependencies };
  }

  /**
   * Links a dynamic import as it runs, adding it to the dependencies of the `running` execution, or else of the
   * importing helper.
   */
  async #linkDynamic(importer: Importer, specifier: string, running: Dependencies | undefined): Promise<string> {
    // A helper initializes outside any execution, once for every execution using it.
    const helper = !running && importer.kind === "helper" ? await this.#helpers.get(importer.requestedURL)?.promise : undefined;
    return this.#link(specifier, importer, [importer.url], running ?? helper?.dependencies);
  }

  /** Links an import of `importer`, below `chain`, to the URL of a module it can import; helpers are added to `dependencies`. */
  async #link(specifier: string, importer: Importer, chain: readonly string[], dependencies: Dependencies | undefined, parent?: Link): Promise<string> {
    const { url } = importer;
    if (specifier.startsWith("#")) {
      throw new GLTSError(`Unsupported subpath import: ${specifier}`, { importChain: chain, phase: "resolve", url });
    }
    if (importer.kind !== "package") {
      const target = classifyImport(specifier, url, chain);
      if (target.kind === "runtime") return this.#bridge.runtimeURL;
      // A script's static imports of it are compiled to reads of its exports, which no module can provide.
      if (target.kind === "glts" && importer.kind === "script") {
        throw new GLTSError(`Dynamic imports cannot bind ${gltsSpecifier}; import it statically`, { importChain: chain, phase: "resolve", url });
      }
      if (target.kind === "glts") return this.#bridge.helperGLTSURL;
      if (target.kind === "helper") return this.#linkHelper(target.url, importer, chain, dependencies, parent);
    }

    const host = this.#bridge.hostModuleURL(specifier);
    if (host) return host;
    const bare = isBareSpecifier(specifier);
    // Scripts share the host's package instances; the host imports what resolve returns natively.
    if (bare && this.#resolve && !hasVersion(specifier)) {
      try {
        const resolved = this.#resolve(specifier);
        if (resolved !== undefined) return resolved;
      } catch (error) {
        throw new GLTSError(`Unable to resolve ${specifier} from the host`, { importChain: chain, phase: "resolve", url }, error);
      }
    }

    const target = bare
      ? cdnPackageURL(specifier, this.#cdnURL, this.#external, REVISION)
      : new URL(specifier, url);
    const peer = peerName(specifier, target, this.#cdnURL);
    if (peer) return this.#link(peer, importer, chain, dependencies, parent);
    if (target.protocol !== "http:" && target.protocol !== "https:") return target.href;
    const href = canonicalize(target);
    return linkOnce(this.#packages, href, chain, async (chain, link) => {
      const fetched = await fetchSource(this.#fetch, href, false, chain);
      const packageImporter: Importer = { kind: "package", requestedURL: href, url: fetched.url };
      return moduleURL(await this.#linkModule(fetched, packageImporter, chain, undefined, "Unable to link package module", link));
    }, parent);
  }

  async #linkHelper(url: string, importer: Importer, chain: readonly string[], dependencies: Dependencies | undefined, parent?: Link): Promise<string> {
    // Added before the fetch, so a change from here on reloads the scripts using it, and one missing is listed.
    this.#addToHistory(importer, url);
    dependencies?.add(url);
    const helper = await linkOnce(this.#helpers, url, chain, (chain, link) => this.#linkFile("helper", url, chain, link), parent);
    dependencies?.include(helper.dependencies);
    return helper.module;
  }

  /** Adds `url`, its own fetched URL or a helper it imports, to the import history of `importer`. */
  #addToHistory(importer: Importer, url: string): void {
    const history = importer.kind === "script" ? this.#scriptHistory : this.#helperHistory;
    const urls = history.get(importer.requestedURL) ?? new Set<string>();
    history.set(importer.requestedURL, urls);
    urls.add(url);
  }

  /** Whether the files at `urls` are, or transitively import, the file at `url`. */
  #uses(urls: Iterable<string>, url: string): boolean {
    const pending = [...urls];
    const visited = new Set<string>();
    for (const next of pending) {
      if (next === url) return true;
      if (visited.has(next)) continue;
      visited.add(next);
      pending.push(...this.#helperHistory.get(next) ?? []);
    }
    return false;
  }

  /** Links a module's static imports now and its dynamic imports when they run. */
  async #linkModule(
    source: Source,
    importer: Importer,
    chain: readonly string[],
    dependencies: Dependencies | undefined,
    message: string,
    link: Link,
  ): Promise<string> {
    try {
      return await rewriteModule(
        source,
        chain,
        (specifier) => this.#link(specifier, importer, chain, dependencies, link),
        this.#bridge.dynamicImportSource(importer),
        this.#env,
      );
    } catch (error) {
      throw toGLTSError(error, message, { importChain: chain, phase: "transform", url: source.url });
    }
  }
}
