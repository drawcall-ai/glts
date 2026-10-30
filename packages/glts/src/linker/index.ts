import { Dependencies } from "../dependencies.js";
import { GLTSError, toGLTSError } from "../errors.js";
import { gltsSpecifier } from "../imports.js";
import type { GLTSLoaderOptions, GLTSModules, GLTSResolve } from "../types.js";
import { withoutQuery } from "../urls.js";
import type { Waiter } from "../waits.js";
import { Bridge } from "./bridge.js";
import { linkOnce, type Entry } from "./cache.js";
import { fetchSource, type Fetch, type Source } from "./fetch.js";
import { ImportHistory } from "./history.js";
import { recordHost, sourceHash } from "./provenance.js";
import { precompiledPrefix } from "./precompiled.js";
import { cdnPackageURL, classifyImport, hasVersion, isBareSpecifier, packageName, resolveImport } from "./resolution.js";
import { parseImports, rewriteModule } from "./rewrite.js";

/** A linked module: its URL, with its imports linked, and the files it uses, its dynamic imports' included. */
interface Module {
  readonly module: string;
  readonly dependencies: Dependencies;
}

/** A linked script or helper; a script's dependencies exclude its own URLs, since its query variants share it. */
interface LinkedFile extends Module {
  readonly fetchedURL: string;
}

/** A script linked for one request. */
export interface Script {
  /** The URL of its module, shared by the script's query variants. */
  readonly module: string;
  /** The URL this request named, with its query. */
  readonly requestedURL: string;
  /** Fetched script path with this request's query. */
  readonly executionURL: string;
  /** The files it uses, its requested and execution URLs included. */
  readonly dependencies: Dependencies;
  readonly env?: GLTSLoaderOptions["env"];
}

/** The script, helper, or package a linked module was made from. */
export interface Importer {
  readonly kind: "script" | "helper" | "package";
  /**
   * The URL its linked module is shared under: a script's requested URL without its query, so query variants share
   * it, or a helper's or package's requested URL, as an import that differs by query is another module.
   */
  readonly key: string;
  /** The URL it was fetched from, after redirects, which its relative imports resolve against. */
  readonly fetchedURL: string;
}

/** Links scripts and their imports into modules for one loader, sharing helpers, host modules, and packages between scripts. */
export class Linker {
  readonly #cdnURL: URL;
  readonly #fetch: Fetch;
  readonly #resolve: GLTSResolve | undefined;
  readonly #bridge: Bridge;
  readonly #external: readonly string[];
  readonly #env: GLTSLoaderOptions["env"];
  readonly #moduleSources: GLTSLoaderOptions["moduleSources"];
  readonly #linkDynamicImports: boolean;
  readonly #history = new ImportHistory();
  /** The literal dynamic imports getModules links after their importers. */
  readonly #dynamicLinks: (() => Promise<string>)[] = [];
  // Linked files and modules, by Importer.key.
  readonly #scripts = new Map<string, Entry<LinkedFile>>();
  readonly #helpers = new Map<string, Entry<LinkedFile>>();
  readonly #packages = new Map<string, Entry<Module>>();

  constructor({ cdnURL, fetch, modules, moduleSources, resolve, external = [], env, linkDynamicImports = false }: {
    readonly cdnURL: URL;
    readonly fetch: Fetch;
    /** Every namespace the host shares by bare specifier or absolute helper URL. */
    readonly modules: GLTSModules;
    readonly moduleSources?: GLTSLoaderOptions["moduleSources"];
    /**
     * Whether getModules also links literal dynamic imports, which bundlers include before a caller takes that branch.
     * Fixed per linker, as linked modules are cached and record their dynamic imports only when first linked.
     */
    readonly linkDynamicImports?: boolean;
    readonly resolve?: GLTSResolve | undefined;
    readonly external?: readonly string[] | undefined;
    readonly env?: GLTSLoaderOptions["env"];
  }) {
    this.#cdnURL = cdnURL;
    this.#fetch = fetch;
    this.#resolve = resolve;
    this.#bridge = new Bridge(modules);
    this.#external = [...this.#bridge.hostSpecifiers.filter(isBareSpecifier), ...external];
    this.#env = env === undefined ? undefined : { ...env };
    this.#moduleSources = moduleSources;
    this.#linkDynamicImports = linkDynamicImports;
  }

  /** Links package graphs for bundlers that supply their namespaces separately, one module per specifier. */
  async getModules(specifiers: readonly string[]): Promise<Module[]> {
    const url = this.#cdnURL.href;
    const modules = await Promise.all(specifiers.map(async (specifier) => {
      const dependencies = new Dependencies();
      const module = await this.#link(specifier, { kind: "package", key: url, fetchedURL: url }, [], dependencies);
      return { module, dependencies };
    }));
    // Includes links added while iterating, so every graph's dependencies are complete.
    for (const linkDynamic of this.#dynamicLinks) await linkDynamic();
    return modules;
  }

  /** The script at `requestedURL`, sharing its linked source file until invalidated. */
  async getScript(requestedURL: string): Promise<Script> {
    this.#history.request(requestedURL);
    const script = await linkOnce(this.#scripts, withoutQuery(requestedURL), [], (chain, waiter) => this.#linkFile("script", requestedURL, chain, waiter));
    const executionURL = new URL(script.fetchedURL);
    executionURL.search = new URL(requestedURL).search;
    const dependencies = new Dependencies();
    dependencies.add(requestedURL, executionURL.href);
    dependencies.include(script.dependencies);
    return { module: script.module, requestedURL, executionURL: executionURL.href, dependencies, env: this.#env };
  }

  /**
   * Forgets the script or helper at `url`, the helpers using it, and the scripts using it, including scripts still
   * fetching it, so they link fresh. Returns the scripts using it, or else `url` itself, which may be a script.
   */
  invalidate(url: string): string[] {
    const { helpers, scripts, requests } = this.#history.affected(url, this.#helpers.keys());
    for (const helper of helpers) this.#helpers.delete(helper);
    for (const script of scripts) this.#scripts.delete(script);
    return requests.length > 0 ? requests : [url];
  }

  dispose(): void {
    this.#bridge.dispose();
  }

  /** Links the script or helper at `requestedURL`, `chain` ending at it. */
  async #linkFile(kind: "script" | "helper", requestedURL: string, chain: readonly string[], waiter: Waiter): Promise<LinkedFile> {
    const script = kind === "script";
    const fetched = await fetchSource(this.#fetch, requestedURL, true, chain);
    const importer: Importer = { kind, key: script ? withoutQuery(requestedURL) : requestedURL, fetchedURL: fetched.url };
    const dependencies = new Dependencies();
    // Query variants share a script's linked file; each execution records its own URLs (getScript).
    if (script) dependencies.addPackage(gltsSpecifier);
    else dependencies.add(fetched.url, requestedURL);
    this.#history.add(importer, fetched.url);
    let source = fetched.source;
    if (!source.startsWith(precompiledPrefix)) {
      const { compileScript, compileHelper } = await import("./compile.js");
      source = script ? compileScript(source, fetched.url) : compileHelper(source, fetched.url, chain);
    }
    const linked = await this.#linkModule(
      { source, url: fetched.url },
      importer,
      // A script's chain starts at the URL it was fetched from.
      script ? [fetched.url] : chain,
      dependencies,
      script ? "Unable to link GLTS script" : "Unable to link helper",
      waiter,
    );
    const module = this.#bridge.module(linked);
    return { fetchedURL: fetched.url, module, dependencies };
  }

  /** Links an import of `importer`, below `chain`, to the URL of a module it can import; helpers are added to `dependencies`. */
  async #link(specifier: string, importer: Importer, chain: readonly string[], dependencies: Dependencies, waiter?: Waiter): Promise<string> {
    const { fetchedURL: url } = importer;
    if (specifier.startsWith("#")) {
      throw new GLTSError(`Unsupported subpath import: ${specifier}`, { importChain: chain, phase: "resolve", url });
    }
    if (importer.kind !== "package") {
      const target = classifyImport(specifier, url, chain);
      // A script's static imports of it are compiled to reads of its exports, which no module can provide.
      if (target.kind === "glts") {
        const message = importer.kind === "script"
          ? `Dynamic imports cannot bind ${gltsSpecifier}; import it statically`
          : `Helpers import only types from ${gltsSpecifier}; pass script bindings to them instead`;
        throw new GLTSError(message, { importChain: chain, phase: "resolve", url });
      }
      if (target.kind === "helper") return this.#linkHelper(target.url, importer, chain, dependencies, waiter);
    }

    const target = resolveImport(specifier, url, this.#cdnURL);
    // A peer the CDN left unbundled imports like its package name.
    const name = "package" in target ? target.package : specifier;
    const host = this.#bridge.hostModuleURL(name);
    if (host) {
      recordHost(name, this.#moduleSources, dependencies, { phase: "resolve", url, importChain: chain });
      return host;
    }
    // Scripts share the host's package instances; the host imports what resolve returns natively.
    if ("package" in target && this.#resolve && !hasVersion(name)) {
      try {
        const resolved = this.#resolve(name);
        if (resolved !== undefined) {
          dependencies.addPackage(packageName(name));
          return resolved;
        }
      } catch (error) {
        throw new GLTSError(`Unable to resolve ${name} from the host`, { importChain: chain, phase: "resolve", url }, error);
      }
    }

    const href = "url" in target ? target.url : cdnPackageURL(name, this.#cdnURL, this.#external).href;
    if (!/^https?:/.test(href)) return href;
    const linked = await linkOnce(this.#packages, href, chain, async (chain, packageWaiter) => {
      const fetched = await fetchSource(this.#fetch, href, false, chain);
      const dependencies = new Dependencies();
      dependencies.addModule(fetched.url, await sourceHash(fetched.source), "runtime");
      const packageImporter: Importer = { kind: "package", key: href, fetchedURL: fetched.url };
      const module = this.#bridge.module(await this.#linkModule(fetched, packageImporter, chain, dependencies, "Unable to link package module", packageWaiter));
      return { module, dependencies };
    }, waiter);
    dependencies.include(linked.dependencies);
    return linked.module;
  }

  async #linkHelper(url: string, importer: Importer, chain: readonly string[], dependencies: Dependencies, waiter?: Waiter): Promise<string> {
    // Added before the fetch, so a change from here on reloads the scripts using it, and one missing is listed.
    this.#history.add(importer, url);
    dependencies.add(url);
    const helper = await linkOnce(this.#helpers, url, chain, (chain, helperWaiter) => this.#linkFile("helper", url, chain, helperWaiter), waiter);
    dependencies.include(helper.dependencies);
    return this.#bridge.hostModuleURL(url) ?? this.#bridge.hostModuleURL(helper.fetchedURL) ?? helper.module;
  }

  /**
   * Links a module's static imports now and its dynamic imports when they run, or in getModules, recording both into
   * `dependencies`. A dynamic import links apart from this module's link, so one importing the module back is no
   * cycle; getModules links them after their importer, as the two would otherwise wait on each other.
   */
  async #linkModule(
    source: Source,
    importer: Importer,
    chain: readonly string[],
    dependencies: Dependencies,
    message: string,
    waiter: Waiter,
  ): Promise<string> {
    try {
      const imports = parseImports(source, chain);
      const linkDynamic = (specifier: string): Promise<string> =>
        this.#link(specifier, importer, [importer.fetchedURL], dependencies);
      for (const { specifier } of imports.dynamicImports) {
        if (!specifier) continue;
        // Host identities are known before execution, even for imports generation has not used yet; they never fetch.
        const host = specifier !== gltsSpecifier && isBareSpecifier(specifier) && this.#bridge.hostModuleURL(specifier);
        if (host) await this.#link(specifier, importer, chain, dependencies, waiter);
        else if (this.#linkDynamicImports) this.#dynamicLinks.push(() => linkDynamic(specifier));
      }
      return await rewriteModule(
        source,
        imports,
        (specifier) => this.#link(specifier, importer, chain, dependencies, waiter),
        // Bound now, so an import running after invalidation still records into this module's dependencies.
        () => this.#bridge.dynamicImportSource(importer.fetchedURL, linkDynamic),
        this.#env,
      );
    } catch (error) {
      throw toGLTSError(error, message, { importChain: chain, phase: "transform", url: source.url });
    }
  }
}
