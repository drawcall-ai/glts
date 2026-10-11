import { resolve } from "node:path";
import { normalizePath, type Plugin } from "vite";

import { isBareSpecifier, packageURL } from "../modules/resolution.js";
import type { GLTSURL } from "../types.js";
import { appDependencies, packageName, scan, type Scan, type ScanOptions } from "./scan.js";

/** Replaces app imports of @drawcall/glts. */
const loaderId = "\0glts:loader";
const modulesId = "\0glts:modules";
/** Prefixes CDN URLs, so Vite serves and bundles the fetched code like any other module. */
const cdnPrefix = "\0glts:cdn:";

function loaderSource(cdnURL: string): string {
  return `
import { GLTSLoader as Loader } from "@drawcall/glts";
import modules from "virtual:glts-modules";
export * from "@drawcall/glts";

export class GLTSLoader extends Loader {
  #update = ({ url }) => void this.reload(new URL(url, location.href));

  constructor(manager, options = {}) {
    super(manager, { cdnURL: ${JSON.stringify(cdnURL)}, ...options, modules: { ...modules, ...options.modules } });
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

interface Project extends ScanOptions {
  scan: Promise<Scan>;
}

interface CDNModule {
  /** The URL after redirects, which relative imports resolve against. */
  readonly url: string;
  readonly code: string;
}

async function fetchModule(url: string): Promise<CDNModule> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Unable to fetch ${url}: ${response.status} ${response.statusText}`);
  return { url: response.url, code: await response.text() };
}

export interface GLTSPluginOptions {
  /** Where script imports the app does not depend on come from; defaults to https://esm.sh/. */
  cdnURL?: GLTSURL;
}

/**
 * Bundles the packages `.glts` files import, sharing the app's dependencies
 * and fetching the rest from the CDN, and hot reloads edited `.glts` files.
 */
export function glts({ cdnURL = "https://esm.sh/" }: GLTSPluginOptions = {}): Plugin {
  const cdnBase = new URL(cdnURL);
  const cdnModules = new Map<string, Promise<CDNModule>>();
  let project: Project | undefined;

  const current = (): Project => {
    if (!project) throw new Error("The glts plugin has not been configured");
    return project;
  };
  // An explicit version always comes from the CDN.
  const isShared = (specifier: string): boolean => {
    const name = packageName(specifier);
    return !specifier.startsWith(`${name}@`) && current().dependencies.includes(name);
  };
  const cdnModule = (url: string): Promise<CDNModule> => {
    const cached = cdnModules.get(url);
    if (cached) return cached;
    const module = fetchModule(url);
    cdnModules.set(url, module);
    void module.catch(() => cdnModules.delete(url));
    return module;
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
      const outDir = normalizePath(resolve(root, config.build?.outDir ?? "dist"));
      const dirs = publicDir && !publicDir.startsWith(`${root}/`) ? [root, publicDir] : [root];
      const paths = { dirs, outDir, dependencies: appDependencies(root) };
      project = { ...paths, scan: scan(paths) };
      // A failed scan rejects again where the map loads.
      const specifiers = await project.scan.then(({ importers }) => [...importers.keys()], () => []);
      // Vite's dependency scan cannot see through the virtual modules.
      return { optimizeDeps: { include: ["@drawcall/glts", ...specifiers.filter(isShared)] } };
    },
    async resolveId(id, importer) {
      if (id === "@drawcall/glts") return importer === loaderId ? undefined : loaderId;
      if (id === "virtual:glts-modules") return modulesId;
      if (id.startsWith(cdnPrefix)) return id;
      if (importer?.startsWith(cdnPrefix) && !isBareSpecifier(id)) {
        const { url } = await cdnModule(importer.slice(cdnPrefix.length));
        return cdnPrefix + new URL(id, url).href;
      }
      if (importer !== modulesId && !importer?.startsWith(cdnPrefix)) return;

      if (isShared(id)) {
        // Resolved like an app import, so scripts share the app's (optimized) instance.
        const resolved = await this.resolve(id);
        if (!resolved) this.error(`${id} is declared in package.json but cannot be resolved`);
        return resolved;
      }

      const { importers, external, versions } = await current().scan;
      const specifier = versions.get(id) ?? id;
      // A package in its own external list comes back unbundled, one module per file.
      const url = packageURL(specifier, cdnBase, external.filter((name) => name !== packageName(specifier))).href;
      if (importer === modulesId) {
        await cdnModule(url).catch((error: unknown) =>
          this.error(`Unable to load ${id}, imported by ${importers.get(id)?.join(", ")}: ${String(error)}`));
      }
      return cdnPrefix + url;
    },
    async load(id) {
      if (id === loaderId) return loaderSource(cdnBase.href);
      if (id === modulesId) return modulesSource([...(await current().scan).importers.keys()]);
      if (id.startsWith(cdnPrefix)) return (await cdnModule(id.slice(cdnPrefix.length))).code;
    },
    async hotUpdate({ type, file }) {
      if (!file.endsWith(".glts")) return;
      const state = current();
      const specifiers = (scan: Promise<Scan>): Promise<string | undefined> =>
        scan.then(({ importers }) => [...importers.keys()].join(), () => undefined);
      const before = await specifiers(state.scan);
      state.scan = scan(state);
      // A broken script keeps the page; the loader reports its syntax error.
      const after = await specifiers(state.scan);
      if (after !== undefined && after !== before) {
        const module = this.environment.moduleGraph.getModuleById(modulesId);
        if (module) this.environment.moduleGraph.invalidateModule(module);
        this.environment.hot.send({ type: "full-reload" });
        return;
      }
      if (type !== "update") return;

      const { root, publicDir, base } = this.environment.config;
      const dir = [publicDir, root].find((path) => path && file.startsWith(`${path}/`));
      if (dir) this.environment.hot.send("glts:update", { url: base + file.slice(dir.length + 1) });
    }
  };
}
