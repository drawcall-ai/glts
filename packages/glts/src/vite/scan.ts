import { glob, readFile } from "node:fs/promises";
import { extname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { normalizePath } from "vite";

import { GLTSError } from "../errors.js";
import { providedSpecifiers } from "../imports.js";
import { compileHelper, compileScript } from "../linker/compile.js";
import type { Source } from "../linker/fetch.js";
import { classifyImport, isBareSpecifier } from "../linker/resolution.js";
import { parseImports } from "../linker/rewrite.js";

/** An import of a helper, which `staticPackages` reads to follow its imports. */
interface HelperImport {
  /** The helper's URL. */
  readonly url: string;
  readonly specifier: string;
  /** The URL of the script or helper importing it. */
  readonly importerURL: string;
}

/** The specifiers of the static and literal dynamic imports of a compiled script or helper. */
function importSpecifiers(source: Source): string[] {
  const { staticImports, dynamicImports } = parseImports(source, [source.url]);
  return [...staticImports, ...dynamicImports].flatMap(({ specifier }) => specifier ?? []);
}

/**
 * The bare specifiers of the packages `scripts` import, except loader-provided ones, sorted, following helpers as
 * the linker links them but without linking: each file compiled as the linker compiles it, and only the imports
 * whose specifiers are literals. `readHelper` returns compiled helper code, or undefined to skip it. A file whose
 * imports the loader would reject is recorded in `failures` instead, its imports skipped.
 */
function staticPackages(
  scripts: readonly Source[],
  readHelper: (helper: HelperImport) => string | undefined,
  failures: Map<string, unknown>,
): string[] {
  const pending = [...scripts];
  /** Helpers read or skipped. */
  const seen = new Set<string>();
  const packages = new Set<string>();
  // Grows while it is iterated, as helpers import more helpers.
  for (const { source, url } of pending) {
    /** Compiled helpers by URL, or undefined for the skipped ones. */
    const helpers = new Map<string, string | undefined>();
    const imported: string[] = [];
    try {
      for (const specifier of importSpecifiers({ source, url })) {
        const target = classifyImport(specifier, url, [url]);
        if (target.kind === "helper") {
          if (seen.has(target.url) || helpers.has(target.url)) continue;
          helpers.set(target.url, readHelper({ url: target.url, specifier, importerURL: url }));
          continue;
        }
        const provided = providedSpecifiers.some((name) => name === specifier);
        if (target.kind === "package" && isBareSpecifier(specifier) && !provided) imported.push(specifier);
      }
    } catch (error) {
      failures.set(normalizePath(fileURLToPath(url)), error);
      continue;
    }
    for (const [helperURL, helper] of helpers) {
      seen.add(helperURL);
      if (helper !== undefined) pending.push({ source: helper, url: helperURL });
    }
    for (const specifier of imported) packages.add(specifier);
  }
  return [...packages].sort();
}

export interface Scan {
  /** The `.glts` files in the public directory. */
  readonly scripts: readonly string[];
  /** The bare specifiers the scripts and their helpers import, except loader-provided ones, sorted. */
  readonly specifiers: readonly string[];
  /** Compiled scripts and helpers by absolute file path, served at their original public URLs. */
  readonly compiled: ReadonlyMap<string, string>;
  /** Compile and import errors by absolute file path. Their imports are missing from `specifiers`. */
  readonly failures: ReadonlyMap<string, unknown>;
}

/** Unchanged files retain their compilation across development scans. */
export type CompileCache = Map<string, { readonly source: string; readonly compiled: string }>;

/** The `.glts` files in the public directory, if any, and the packages they and their helpers import. */
export async function scan(publicDir: string | undefined, cache: CompileCache = new Map()): Promise<Scan> {
  const compiled = new Map<string, string>();
  const failures = new Map<string, unknown>();
  if (!publicDir) return { scripts: [], specifiers: [], compiled, failures };
  const scripts: string[] = [];
  const compiledScripts: Source[] = [];
  // Computed dynamic imports can name any public helper, beyond the statically reachable graph.
  for await (const path of glob("**/*.{glts,ts}", { cwd: publicDir })) {
    const file = normalizePath(resolve(publicDir, path));
    const source = await readFile(file, "utf8");
    const previous = cache.get(file);
    const url = pathToFileURL(file).href;
    const script = extname(file) === ".glts";
    if (script) scripts.push(file);
    let code: string;
    try {
      code = previous?.source === source ? previous.compiled
        : script ? compileScript(source, url) : compileHelper(source, url, [url]);
    } catch (error) {
      failures.set(file, error);
      continue;
    }
    cache.set(file, { source, compiled: code });
    compiled.set(file, code);
    if (script) compiledScripts.push({ source: code, url });
  }
  for (const file of cache.keys()) if (!compiled.has(file)) cache.delete(file);
  const readHelper = ({ url, specifier, importerURL }: HelperImport): string | undefined => {
    const path = normalizePath(fileURLToPath(url));
    // Only the public directory is served as source; Vite serves other files transformed, or not at all.
    if (relative(publicDir, path).startsWith("..")) {
      throw new GLTSError(`Helpers must be in the public directory: ${specifier}`, {
        importChain: [importerURL], phase: "resolve", url: importerURL,
      });
    }
    // The type check and the load report a missing helper, naming the script that imports it.
    return compiled.get(path);
  };
  return { scripts: scripts.sort(), specifiers: staticPackages(compiledScripts, readHelper, failures), compiled, failures };
}
