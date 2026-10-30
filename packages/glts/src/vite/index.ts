import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { findPackageJSON } from "node:module";
import { extname, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { normalizePath, type DevEnvironment, type Plugin } from "vite";

import { gltsSpecifier, providedSpecifiers } from "../imports.js";
import { Linker } from "../linker/index.js";
import { precompiledPrefix } from "../linker/precompiled.js";
import { cdnPackageURL, defaultCDNURL, hasVersion, packageName, resolveImport } from "../linker/resolution.js";
import type { GLTSModuleSource, GLTSURL } from "../types.js";
import { hostModulesSource, loaderSource } from "./modules.js";
import { typecheck } from "./typecheck.js";
import { scan, type CompileCache, type Scan } from "./scan.js";
import { warmupBuild } from "./warmup.js";

/** Replaces app imports of @drawcall/glts. */
const loaderId = "\0glts:loader";
const hostModulesId = "\0glts:modules";
/** Prefixes CDN URLs, so Vite serves and bundles the fetched code like any other module. */
const cdnPrefix = "\0glts:cdn:";
const toCDNId = (url: string): string => cdnPrefix + url;
const fromCDNId = (id: string): string | undefined => id.startsWith(cdnPrefix) ? id.slice(cdnPrefix.length) : undefined;

/** The specifiers every loader provides and the packages in the `dependencies` and `devDependencies` of the app's nearest package.json. */
function appPackages(root: string): string[] {
  const path = findPackageJSON(pathToFileURL(`${root}/`));
  if (!path) throw new Error(`No package.json found in ${root} or its parents`);
  const manifest: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (typeof manifest !== "object" || manifest === null) throw new Error(`Invalid ${path}`);
  const names = (field: string): string[] => {
    const packages: unknown = Reflect.get(manifest, field);
    return typeof packages === "object" && packages !== null ? Object.keys(packages) : [];
  };
  return [...providedSpecifiers, ...names("dependencies"), ...names("devDependencies")];
}

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

async function fetchCDNSource(url: string): Promise<string> {
  // Relative imports resolve against the requested URL, which a redirect would change.
  const response = await fetch(url, { redirect: "error" });
  if (!response.ok) throw new Error(`Unable to fetch ${url}: ${response.status} ${response.statusText}`);
  return response.text();
}

interface Project {
  readonly root: string;
  /** Where the app serves the `.glts` files it loads by URL; none when disabled. */
  readonly publicDir: string | undefined;
  readonly packages: readonly string[];
  readonly cache: CompileCache;
  scan: Promise<Scan>;
}

export interface GLTSPluginOptions {
  /** Where script imports the app does not depend on come from; defaults to esm.sh. */
  cdnURL?: GLTSURL;
}

/**
 * Bundles the packages scripts and their helpers import, sharing the
 * app's packages and fetching the rest from the CDN, type checks and precompiles
 * public scripts and helpers, runs every public script during builds to warm
 * asset caches, and hot reloads edited scripts and helpers.
 */
export function glts(options: GLTSPluginOptions = {}): Plugin {
  const cdnURL = new URL(options.cdnURL ?? defaultCDNURL);
  let configuredProject: Project | undefined;
  let failing = false;
  const cdnSources = new Map<string, Promise<string>>();
  const cdnSource = (url: string): Promise<string> => {
    let source = cdnSources.get(url);
    if (!source) {
      source = fetchCDNSource(url).catch((error: unknown) => { cdnSources.delete(url); throw error; });
      cdnSources.set(url, source);
    }
    return source;
  };

  const configured = (): Project => {
    if (!configuredProject) throw new Error("The glts plugin has not been configured");
    return configuredProject;
  };
  const isAppPackage = (specifier: string): boolean =>
    !hasVersion(specifier) && configured().packages.includes(packageName(specifier));
  /** The packages CDN bundles import instead of inlining: the app's and the scripts'. */
  const shared = async (): Promise<string[]> => {
    const { packages, scan: scanning } = configured();
    return [...packages, ...(await scanning).specifiers.map(packageName)];
  };
  const moduleSources = async (specifiers: readonly string[]): Promise<Readonly<Record<string, GLTSModuleSource>>> => {
    const linker = new Linker({
      cdnURL, modules: {}, external: await shared(),
      linkDynamicImports: true,
      resolve: (specifier) => isAppPackage(specifier) ? specifier : undefined,
      fetch: async (input) => new Response(await cdnSource(String(input))),
    });
    try {
      const remote = specifiers.filter((specifier) => !isAppPackage(specifier));
      const modules = await linker.getModules(remote);
      return Object.fromEntries(modules.map(({ dependencies }, index) =>
        [remote[index], { packages: dependencies.packages(), moduleHashes: dependencies.moduleHashes() }]));
    } finally {
      linker.dispose();
    }
  };
  // Reports in the terminal without blocking the server or hot reload.
  const reportTypecheck = async (environment: DevEnvironment, scanning: Promise<Scan>): Promise<void> => {
    const errors = await scanning.then(({ scripts }) => typecheck(scripts)).catch((error: unknown) => String(error));
    // A newer scan reports its own check.
    if (scanning !== configured().scan) return;
    if (errors) environment.logger.error(errors, { timestamp: true });
    else if (failing) environment.logger.info("glts: type errors fixed", { timestamp: true });
    failing = errors !== undefined;
  };

  return {
    name: "glts",
    // Vite's resolver would otherwise claim @drawcall/glts first.
    enforce: "pre",
    applyToEnvironment: (environment) => environment.name === "client",
    async config(config) {
      const root = normalizePath(resolve(config.root ?? ""));
      const publicDir = config.publicDir === false ? undefined
        : normalizePath(resolve(root, config.publicDir ?? "public"));
      const cache: CompileCache = new Map();
      const project = { root, publicDir, packages: appPackages(root), cache, scan: scan(publicDir, cache) };
      configuredProject = project;
      // A failed scan rejects again where the map loads.
      const specifiers = await project.scan.then(({ specifiers }) => specifiers, () => []);
      // Vite's dependency scan cannot see through the virtual modules.
      return { optimizeDeps: { include: [gltsSpecifier, ...specifiers.filter(isAppPackage)] } };
    },
    async buildStart() {
      if (this.environment.config.command !== "build") return;
      const { root, publicDir, packages, scan: scanning } = configured();
      const { scripts, failures } = await scanning;
      // Each message names its file; a plugin stack trace would only bury them.
      if (failures.size > 0) this.error({ message: [...failures.values()].map(errorMessage).join("\n\n"), stack: "" });
      const errors = await typecheck(scripts);
      // The diagnostics locate the errors; a plugin stack trace would only bury them.
      if (errors) this.error({ message: errors, stack: "" });
      if (publicDir && scripts.length > 0) {
        const external = await shared();
        const env = { ...this.environment.config.env, SSR: true };
        await warmupBuild({ root, publicDir, packages, external, scripts, env, cdnURL: cdnURL.href, base: this.environment.config.base });
      }
    },
    configureServer({ environments: { client }, config, middlewares }) {
      void reportTypecheck(client, configured().scan);
      const base = new URL(config.base, "http://glts.local/").pathname;
      middlewares.use((request, response, next) => {
        const project = configured();
        if (!project.publicDir || (request.method !== "GET" && request.method !== "HEAD")) return next();
        const { pathname } = new URL(request.url ?? "/", "http://glts.local/");
        if (![".glts", ".ts"].includes(extname(pathname))) return next();
        let path: string;
        try { path = decodeURIComponent(pathname); }
        // A malformed escape names no public file; Vite answers it as any other request.
        catch { return next(); }
        if (!path.startsWith(base)) return next();
        const file = normalizePath(resolve(project.publicDir, path.slice(base.length)));
        // App modules share these extensions; only public files wait on the scan.
        if (relative(project.publicDir, file).startsWith("..") || !existsSync(file)) return next();
        const send = (source: string): void => {
          response.setHeader("Content-Type", "text/javascript");
          response.setHeader("Cache-Control", "no-cache");
          response.end(request.method === "HEAD" ? undefined : source);
        };
        void project.scan.then(({ compiled }) => compiled.get(file), () => undefined).then((code) => {
          if (code !== undefined) return send(precompiledPrefix + code);
          // Uncompiled source makes the loader compile it and report the located error.
          readFile(file, "utf8").then(send, () => next());
        });
      });
    },
    async generateBundle() {
      const { publicDir, scan: scanning } = configured();
      if (!publicDir) return;
      for (const [file, source] of (await scanning).compiled) {
        this.emitFile({ type: "asset", fileName: normalizePath(relative(publicDir, file)), source: precompiledPrefix + source });
      }
    },
    async resolveId(id, importer) {
      if (id === gltsSpecifier) return importer === loaderId ? undefined : loaderId;
      if (id === "virtual:glts-modules") return hostModulesId;
      // Dev serves modules by id and resolves those ids again.
      if (fromCDNId(id) !== undefined) return id;
      const importerURL = importer && fromCDNId(importer);
      if (importer !== hostModulesId && !importerURL) return;
      // The CDN graph resolves as the loader links it, so the bundled modules are the ones moduleSources hashes.
      const target = resolveImport(id, importerURL || cdnURL.href, cdnURL);
      if ("url" in target) return toCDNId(target.url);
      if (isAppPackage(target.package)) {
        // Resolved like an app import, so scripts share the app's (optimized) instance.
        const resolved = await this.resolve(target.package);
        if (!resolved) this.error(`${target.package} is declared in package.json but cannot be resolved`);
        return resolved;
      }
      // CDN bundles import the app's and the scripts' packages, so each has one instance.
      return toCDNId(cdnPackageURL(target.package, cdnURL, await shared()).href);
    },
    async load(id) {
      if (id === loaderId) return loaderSource(cdnURL.href, { ...this.environment.config.env, SSR: false });
      if (id === hostModulesId) {
        const { specifiers } = await configured().scan;
        return hostModulesSource(specifiers, await moduleSources(specifiers));
      }
      const url = fromCDNId(id);
      if (url !== undefined) return cdnSource(url);
    },
    async hotUpdate({ type, file }) {
      const project = configured();
      // Apps load scripts by URL, so only public scripts and helpers are scanned and reloaded.
      if (!project.publicDir || ![".glts", ".ts"].includes(extname(file))) return;
      const path = relative(project.publicDir, file);
      if (path.startsWith("..")) return;
      const previous = project.scan;
      project.scan = scan(project.publicDir, project.cache);
      // A broken script keeps the page; the loader reports its error.
      const [before, after] = await Promise.all([previous, project.scan]
        .map((result) => result.then(({ specifiers, failures }) => failures.size ? undefined : specifiers, () => undefined)));
      // The synchronous check would delay serving the reloaded script.
      const latest = project.scan;
      setTimeout(() => void reportTypecheck(this.environment, latest), 100);
      if (after && !isDeepStrictEqual(before, after)) {
        const module = this.environment.moduleGraph.getModuleById(hostModulesId);
        if (module) this.environment.moduleGraph.invalidateModule(module);
        this.environment.hot.send({ type: "full-reload" });
        return;
      }
      if (type === "delete") return;
      // Creations reload too: a created helper may be one a failed reload is missing.
      this.environment.hot.send("glts:reload", { url: this.environment.config.base + normalizePath(path) });
    }
  };
}
