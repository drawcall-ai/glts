import type { Program } from "@babel/types";
import { existsSync, readFileSync } from "node:fs";
import { glob, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
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
  /** The `.glts` files in the public directory. */
  readonly scripts: readonly string[];
  /** The files importing each script specifier. */
  readonly importers: ReadonlyMap<string, readonly string[]>;
  /** Packages CDN bundles import instead of inlining: the app's and the scripts' packages. */
  readonly external: readonly string[];
  /** Versioned script imports by package name, which CDN bundles importing that package share. */
  readonly versions: ReadonlyMap<string, string>;
}

export interface ScanOptions {
  /** Where the app serves the `.glts` files it loads by URL; none when disabled. */
  readonly publicDir: string | undefined;
  /** The app's dependencies, from `appDependencies`. */
  readonly dependencies: readonly string[];
}

/** The script imports of the `.glts` files in the public directory, and how CDN bundles share them. */
export async function scan({ publicDir, dependencies }: ScanOptions): Promise<Scan> {
  const scripts = publicDir ? await scriptsIn(publicDir) : [];
  const importers = await importersOf(scripts);
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
    scripts,
    importers,
    external: [...new Set([...dependencies, ...specifiers.map(packageName)])].sort(),
    versions: new Map(versioned.map((specifier) => [packageName(specifier), specifier])),
  };
}

async function scriptsIn(dir: string): Promise<string[]> {
  const scripts: string[] = [];
  for await (const path of glob("**/*.glts", { cwd: dir })) scripts.push(normalizePath(resolve(dir, path)));
  return scripts.sort();
}

/** Maps each specifier the scripts import to the scripts importing it, sorted. */
async function importersOf(scripts: readonly string[]): Promise<Map<string, string[]>> {
  const importers = new Map<string, string[]>();
  for (const file of scripts) {
    for (const specifier of importedSpecifiers(await readFile(file, "utf8"), file)) {
      importers.set(specifier, [...importers.get(specifier) ?? [], file]);
    }
  }
  return new Map([...importers].sort(([a], [b]) => a.localeCompare(b)));
}
