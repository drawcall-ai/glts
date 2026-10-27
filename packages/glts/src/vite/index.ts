import { readFileSync } from "node:fs";
import { findPackageJSON } from "node:module";
import { extname, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { normalizePath, type DevEnvironment, type Plugin } from "vite";

import { gltsSpecifier, providedSpecifiers } from "../imports.js";
import { cdnPackageURL, defaultCDNURL, hasVersion, isBareSpecifier, packageName } from "../linker/resolution.js";
import type { GLTSURL } from "../types.js";
import { typecheck } from "./typecheck.js";
import { scan, type Scan } from "./scan.js";

/** Replaces app imports of @drawcall/glts. */
const loaderId = "\0glts:loader";
const hostModulesId = "\0glts:modules";
/** Prefixes CDN URLs, so Vite serves and bundles the fetched code like any other module. */
const cdnPrefix = "\0glts:cdn:";
const toCDNId = (url: string): string => cdnPrefix + url;
const fromCDNId = (id: string): string | undefined => id.startsWith(cdnPrefix) ? id.slice(cdnPrefix.length) : undefined;

function loaderSource(cdnURL: string): string {
  return `
import { GLTSLoader as Loader } from "@drawcall/glts";
import modules from "virtual:glts-modules";
export * from "@drawcall/glts";

export class GLTSLoader extends Loader {
  #reload = ({ url }) => void this.reload(new URL(url, location.href));

  constructor(manager, options = {}) {
    super(manager, { cdnURL: ${JSON.stringify(cdnURL)}, ...options, modules: { ...modules, ...options.modules } });
    import.meta.hot?.on("glts:reload", this.#reload);
  }

  dispose() {
    import.meta.hot?.off("glts:reload", this.#reload);
    super.dispose();
  }
}
`;
}

function hostModulesSource(specifiers: readonly string[]): string {
  const imports = specifiers.map((specifier, index) =>
    `import * as m${index} from ${JSON.stringify(specifier)};`);
  const entries = specifiers.map((specifier, index) => `${JSON.stringify(specifier)}: m${index}`);
  return [...imports, `export default { ${entries.join(", ")} };`].join("\n");
}

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

async function fetchCDNSource(url: string): Promise<string> {
  // Relative imports resolve against the requested URL, which a redirect would change.
  const response = await fetch(url, { redirect: "error" });
  if (!response.ok) throw new Error(`Unable to fetch ${url}: ${response.status} ${response.statusText}`);
  return response.text();
}

interface Project {
  /** Where the app serves the `.glts` files it loads by URL; none when disabled. */
  readonly publicDir: string | undefined;
  readonly packages: readonly string[];
  scan: Promise<Scan>;
}

export interface GLTSPluginOptions {
  /** Where script imports the app does not depend on come from; defaults to esm.sh. */
  cdnURL?: GLTSURL;
}

/**
 * Bundles the packages scripts and their helpers import, sharing the
 * app's packages and fetching the rest from the CDN, type checks the
 * scripts, and hot reloads edited scripts and helpers.
 */
export function glts(options: GLTSPluginOptions = {}): Plugin {
  const cdnURL = new URL(options.cdnURL ?? defaultCDNURL);
  let configuredProject: Project | undefined;
  let failing = false;

  const configured = (): Project => {
    if (!configuredProject) throw new Error("The glts plugin has not been configured");
    return configuredProject;
  };
  const isAppPackage = (specifier: string): boolean =>
    !hasVersion(specifier) && configured().packages.includes(packageName(specifier));
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
      const project = { publicDir, packages: appPackages(root), scan: scan(publicDir) };
      configuredProject = project;
      // A failed scan rejects again where the map loads.
      const specifiers = await project.scan.then(({ specifiers }) => specifiers, () => []);
      // Vite's dependency scan cannot see through the virtual modules.
      return { optimizeDeps: { include: [gltsSpecifier, ...specifiers.filter(isAppPackage)] } };
    },
    async buildStart() {
      if (this.environment.config.command !== "build") return;
      const errors = await typecheck((await configured().scan).scripts);
      // The diagnostics locate the errors; a plugin stack trace would only bury them.
      if (errors) this.error({ message: errors, stack: "" });
    },
    configureServer({ environments: { client } }) {
      void reportTypecheck(client, configured().scan);
    },
    async resolveId(id, importer) {
      if (id === gltsSpecifier) return importer === loaderId ? undefined : loaderId;
      if (id === "virtual:glts-modules") return hostModulesId;
      // Dev serves modules by id and resolves those ids again.
      if (fromCDNId(id) !== undefined) return id;
      const importerURL = importer && fromCDNId(importer);
      if (importer !== hostModulesId && !importerURL) return;
      if (importerURL && !isBareSpecifier(id)) return toCDNId(new URL(id, importerURL).href);

      if (isAppPackage(id)) {
        // Resolved like an app import, so scripts share the app's (optimized) instance.
        const resolved = await this.resolve(id);
        if (!resolved) this.error(`${id} is declared in package.json but cannot be resolved`);
        return resolved;
      }
      // CDN bundles import the app's and the scripts' packages, so each has one instance.
      const { packages, scan: scanning } = configured();
      const names = [...packages, ...(await scanning).specifiers.map(packageName)];
      // No Three revision to pin addons to: `three` is an app package, so its addons never come from the CDN.
      return toCDNId(cdnPackageURL(id, cdnURL, names).href);
    },
    async load(id) {
      if (id === loaderId) return loaderSource(cdnURL.href);
      if (id === hostModulesId) return hostModulesSource((await configured().scan).specifiers);
      const url = fromCDNId(id);
      if (url !== undefined) return fetchCDNSource(url);
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
        .map((result) => result.then(({ specifiers }) => specifiers, () => undefined)));
      // The synchronous check would delay serving the reloaded script.
      const latest = project.scan;
      setTimeout(() => void reportTypecheck(this.environment, latest), 100);
      if (after && !isDeepStrictEqual(before, after)) {
        const module = this.environment.moduleGraph.getModuleById(hostModulesId);
        if (module) this.environment.moduleGraph.invalidateModule(module);
        this.environment.hot.send({ type: "full-reload" });
        return;
      }
      // A created helper may be one a failed reload is missing.
      if (type === "delete") return;

      this.environment.hot.send("glts:reload", { url: this.environment.config.base + normalizePath(path) });
    }
  };
}
