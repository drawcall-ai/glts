import type { Program } from "@babel/types";
import { existsSync, readFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { normalizePath } from "vite";

import { parseScript } from "../modules/compiler.js";
import { isBareSpecifier } from "../modules/resolution.js";

// Every loader provides these itself.
const provided = new Set(["@drawcall/glts", "three"]);

/** The bare specifiers a script imports at runtime, except loader-provided ones. */
function importedSpecifiers(source: string, file: string): string[] {
  let program: Program;
  try {
    program = parseScript(source, file);
  } catch (error) {
    throw new Error(`Unable to parse ${file}: ${String(error)}`, { cause: error });
  }
  return program.body
    .flatMap((statement) =>
      statement.type === "ImportDeclaration" && statement.importKind !== "type" ? [statement.source.value] : [])
    .filter((specifier) => isBareSpecifier(specifier) && !provided.has(specifier));
}

/** The package a bare specifier imports from, e.g. `@scope/x` for `@scope/x@1/sub`. */
export function packageName(specifier: string): string {
  return /^(?:@[^/]+\/)?[^/@]+/.exec(specifier)?.[0] ?? specifier;
}

/** `three` and the dependencies and devDependencies of the app's nearest package.json. */
export function appDependencies(root: string): string[] {
  let dir = root;
  while (!existsSync(join(dir, "package.json"))) {
    if (dirname(dir) === dir) throw new Error(`No package.json found in ${root} or its parents`);
    dir = dirname(dir);
  }
  const manifest: unknown = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  if (typeof manifest !== "object" || manifest === null) throw new Error(`Invalid ${dir}/package.json`);
  const names = (field: string): string[] => {
    const dependencies: unknown = Reflect.get(manifest, field);
    return typeof dependencies === "object" && dependencies !== null ? Object.keys(dependencies) : [];
  };
  return ["three", ...names("dependencies"), ...names("devDependencies")];
}

export interface Scan {
  /** The files importing each script specifier. */
  readonly importers: ReadonlyMap<string, readonly string[]>;
  /** Packages CDN bundles import instead of inlining: the app's and the scripts' packages. */
  readonly external: readonly string[];
  /** Versioned script imports by package name, which CDN bundles importing that package share. */
  readonly versions: ReadonlyMap<string, string>;
}

export interface ScanOptions {
  /** The root, and the public directory when it lies outside the root. */
  readonly dirs: readonly string[];
  readonly outDir: string;
  /** The app's dependencies, from `appDependencies`. */
  readonly dependencies: readonly string[];
}

/** The script imports of the `.glts` files under `dirs`, and how CDN bundles share them. */
export async function scan({ dirs, outDir, dependencies }: ScanOptions): Promise<Scan> {
  const importers = await importersOf(dirs, outDir);
  const specifiers = [...importers.keys()];
  const versioned = specifiers.filter((specifier) => /^@?[^@]+@[^/]+$/.test(specifier));
  // CDN bundles share one instance per package, so a package can have only one version.
  const names = versioned.map(packageName);
  const repeated = names.find((name, index) => names.indexOf(name) !== index);
  if (repeated) {
    const imported = versioned.filter((specifier) => packageName(specifier) === repeated);
    throw new Error(`Scripts import several versions of ${repeated}: ${imported.join(", ")}`);
  }
  return {
    importers,
    external: [...new Set([...dependencies, ...specifiers.map(packageName)])].sort(),
    versions: new Map(versioned.map((specifier) => [packageName(specifier), specifier])),
  };
}

/** Maps each specifier the `.glts` files under `dirs` import to the files importing it, sorted. */
async function importersOf(dirs: readonly string[], outDir: string): Promise<Map<string, string[]>> {
  const importers = new Map<string, string[]>();
  const files = (await Promise.all(dirs.map((dir) => scripts(dir, outDir)))).flat();
  for (const file of files) {
    for (const specifier of importedSpecifiers(await readFile(file, "utf8"), file)) {
      importers.set(specifier, [...importers.get(specifier) ?? [], file]);
    }
  }
  return new Map([...importers].sort(([a], [b]) => (a < b ? -1 : 1)));
}

async function scripts(dir: string, outDir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(entries.map((entry) => {
    const path = normalizePath(join(dir, entry.name));
    if (!entry.isDirectory()) return entry.name.endsWith(".glts") ? [path] : [];
    const skipped = entry.name === "node_modules" || entry.name.startsWith(".") || path === outDir;
    return skipped ? [] : scripts(path, outDir);
  }));
  return files.flat();
}
