import { readFileSync } from "node:fs";
import { findPackageJSON } from "node:module";
import { extname, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { normalizePath, type DevEnvironment, type Plugin } from "vite";

import { defaultCDNURL, isBareSpecifier, packageURL } from "../modules/resolution.js";
import type { GLTSURL } from "../types.js";
import { check } from "./check.js";
import { scan, type Scan } from "./scan.js";

/** Replaces app imports of @drawcall/glts. */
const loaderId = "\0glts:loader";
const modulesId = "\0glts:modules";
/** Prefixes CDN URLs, so Vite serves and bundles the fetched code like any other module. */
const cdnPrefix = "\0glts:cdn:";
const cdnId = (url: string): string => cdnPrefix + url;
const cdnURL = (id: string): string | undefined => id.startsWith(cdnPrefix) ? id.slice(cdnPrefix.length) : undefined;

function loaderSource(cdn: string): string {
  return `
import { GLTSLoader as Loader } from "@drawcall/glts";
import modules from "virtual:glts-modules";
export * from "@drawcall/glts";

export class GLTSLoader extends Loader {
  #update = ({ url }) => void this.reload(new URL(url, location.href));

  constructor(manager, options = {}) {
    super(manager, { cdnURL: ${JSON.stringify(cdn)}, ...options, modules: { ...modules, ...options.modules } });
    import.meta.hot?.on("glts:update", this.#update);
  }

  dispose() {
    import.meta.hot?.off("glts:update", this.#update);
    super.dispose();
  }
}
`;
}

function modulesSource(specifiers: readonly string[]): string {
  const imports = specifiers.map((specifier, index) =>
    `import * as m${index} from ${JSON.stringify(specifier)};`);
  const entries = specifiers.map((specifier, index) => `${JSON.stringify(specifier)}: m${index}`);
  return [...imports, `export default { ${entries.join(", ")} };`].join("\n");
}

/** The package a bare specifier imports from, e.g. `@scope/x` for `@scope/x@1/sub`. */
function packageName(specifier: string): string {
  const name = /^(?:@[^/]+\/)?[^/@]+/.exec(specifier)?.[0];
  if (!name) throw new Error(`Invalid package specifier: ${specifier}`);
  return name;
}

/** `three` and the dependencies and devDependencies of the app's nearest package.json. */
function appDependencies(root: string): string[] {
  const path = findPackageJSON(pathToFileURL(`${root}/`));
  if (!path) throw new Error(`No package.json found in ${root} or its parents`);
  const manifest: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (typeof manifest !== "object" || manifest === null) throw new Error(`Invalid ${path}`);
  const names = (field: string): string[] => {
    const dependencies: unknown = Reflect.get(manifest, field);
    return typeof dependencies === "object" && dependencies !== null ? Object.keys(dependencies) : [];
  };
  return ["three", ...names("dependencies"), ...names("devDependencies")];
}

async function fetchCode(url: string): Promise<string> {
  // Relative imports resolve against the requested URL, which a redirect would change.
  const response = await fetch(url, { redirect: "error" });
  if (!response.ok) throw new Error(`Unable to fetch ${url}: ${response.status} ${response.statusText}`);
  return response.text();
}

interface Project {
  /** Where the app serves the `.glts` files it loads by URL; none when disabled. */
  readonly publicDir: string | undefined;
  readonly dependencies: readonly string[];
  scan: Promise<Scan>;
}

export interface GLTSPluginOptions {
  /** Where script imports the app does not depend on come from; defaults to esm.sh. */
  cdnURL?: GLTSURL;
}

/**
 * Bundles the packages `.glts` files and their helpers import, sharing the
 * app's dependencies and fetching the rest from the CDN, type checks the
 * scripts, and hot reloads edited scripts and helpers.
 */
export function glts(options: GLTSPluginOptions = {}): Plugin {
  const cdnBase = new URL(options.cdnURL ?? defaultCDNURL);
  let configuredProject: Project | undefined;
  let failing = false;

  const configured = (): Project => {
    if (!configuredProject) throw new Error("The glts plugin has not been configured");
    return configuredProject;
  };
  // An explicit version always comes from the CDN.
  const isDependency = (specifier: string): boolean => {
    const name = packageName(specifier);
    return !specifier.startsWith(`${name}@`) && configured().dependencies.includes(name);
  };
  // Reports in the terminal without blocking the server or hot reload.
  const report = async (environment: DevEnvironment, scan: Promise<Scan>): Promise<void> => {
    const errors = await scan.then(({ scripts }) => check(scripts)).catch((error: unknown) => String(error));
    // A newer scan reports its own check.
    if (scan !== configured().scan) return;
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
      const project = { publicDir, dependencies: appDependencies(root), scan: scan(publicDir) };
      configuredProject = project;
      // A failed scan rejects again where the map loads.
      const specifiers = await project.scan.then(({ specifiers }) => specifiers, () => []);
      // Vite's dependency scan cannot see through the virtual modules.
      return { optimizeDeps: { include: ["@drawcall/glts", ...specifiers.filter(isDependency)] } };
    },
    async buildStart() {
      if (this.environment.config.command !== "build") return;
      const errors = await check((await configured().scan).scripts);
      // The diagnostics locate the errors; a plugin stack trace would only bury them.
      if (errors) this.error({ message: errors, stack: "" });
    },
    configureServer({ environments: { client } }) {
      void report(client, configured().scan);
    },
    async resolveId(id, importer) {
      if (id === "@drawcall/glts") return importer === loaderId ? undefined : loaderId;
      if (id === "virtual:glts-modules") return modulesId;
      // Dev serves modules by id and resolves those ids again.
      if (cdnURL(id) !== undefined) return id;
      const importerURL = importer && cdnURL(importer);
      if (importer !== modulesId && !importerURL) return;
      if (importerURL && !isBareSpecifier(id)) return cdnId(new URL(id, importerURL).href);

      if (isDependency(id)) {
        // Resolved like an app import, so scripts share the app's (optimized) instance.
        const resolved = await this.resolve(id);
        if (!resolved) this.error(`${id} is declared in package.json but cannot be resolved`);
        return resolved;
      }
      // CDN bundles import the app's and the scripts' packages, so each has one instance.
      const { dependencies, scan } = configured();
      const names = [...dependencies, ...(await scan).specifiers.map(packageName)];
      // A package in its own external list comes back unbundled, one module per file.
      const external = [...new Set(names)].filter((name) => name !== packageName(id)).sort();
      return cdnId(packageURL(id, cdnBase, external).href);
    },
    async load(id) {
      if (id === loaderId) return loaderSource(cdnBase.href);
      if (id === modulesId) return modulesSource((await configured().scan).specifiers);
      const url = cdnURL(id);
      if (url !== undefined) return fetchCode(url);
    },
    async hotUpdate({ type, file }) {
      const project = configured();
      // Apps load scripts by URL, so only public scripts and helpers are scanned and reloaded.
      if (!project.publicDir || ![".glts", ".ts"].includes(extname(file))) return;
      const path = relative(project.publicDir, file);
      if (path.startsWith("..")) return;
      const previous = project.scan;
      project.scan = scan(project.publicDir);
      // A broken script keeps the page; the loader reports its syntax error.
      const [before, after] = await Promise.all([previous, project.scan]
        .map((scanned) => scanned.then(({ specifiers }) => specifiers, () => undefined)));
      // The synchronous check would delay serving the reloaded script.
      const scanned = project.scan;
      setTimeout(() => void report(this.environment, scanned), 100);
      if (after && !isDeepStrictEqual(before, after)) {
        const module = this.environment.moduleGraph.getModuleById(modulesId);
        if (module) this.environment.moduleGraph.invalidateModule(module);
        this.environment.hot.send({ type: "full-reload" });
        return;
      }
      // A created helper may be one a failed reload is missing.
      if (type === "delete") return;

      this.environment.hot.send("glts:update", { url: this.environment.config.base + normalizePath(path) });
    }
  };
}
