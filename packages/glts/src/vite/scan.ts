import { existsSync } from "node:fs";
import { glob, readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
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
 * whose specifiers are literals. `readHelper` reads a helper once, or returns undefined to skip it.
 */
async function staticPackages(
  scripts: readonly Source[],
  readHelper: (helper: HelperImport) => Promise<string | undefined>,
): Promise<string[]> {
  const pending = scripts.map(({ source, url }) => ({ source: compileScript(source, url), url }));
  /** Helpers read or skipped. */
  const seen = new Set<string>();
  const packages = new Set<string>();
  // Grows while it is iterated, as helpers import more helpers.
  for (const { source, url } of pending) {
    for (const specifier of importSpecifiers({ source, url })) {
      const target = classifyImport(specifier, url, [url]);
      if (target.kind === "helper") {
        if (seen.has(target.url)) continue;
        seen.add(target.url);
        const helper = await readHelper({ url: target.url, specifier, importerURL: url });
        if (helper === undefined) continue;
        pending.push({ source: compileHelper(helper, target.url, [target.url]), url: target.url });
        continue;
      }
      const provided = providedSpecifiers.some((name) => name === specifier);
      if (target.kind === "package" && isBareSpecifier(specifier) && !provided) packages.add(specifier);
    }
  }
  return [...packages].sort();
}

export interface Scan {
  /** The `.glts` files in the public directory. */
  readonly scripts: readonly string[];
  /** The bare specifiers the scripts and their helpers import, except loader-provided ones, sorted. */
  readonly specifiers: readonly string[];
}

/** The `.glts` files in the public directory, if any, and the packages they and their helpers import. */
export async function scan(publicDir: string | undefined): Promise<Scan> {
  if (!publicDir) return { scripts: [], specifiers: [] };
  const scripts: string[] = [];
  for await (const path of glob("**/*.glts", { cwd: publicDir })) scripts.push(normalizePath(resolve(publicDir, path)));
  const sources = await Promise.all(scripts.map(async (file) => ({
    source: await readFile(file, "utf8"),
    url: pathToFileURL(file).href,
  })));
  const readHelper = async ({ url, specifier, importerURL }: HelperImport): Promise<string | undefined> => {
    const path = normalizePath(fileURLToPath(url));
    // Only the public directory is served as source; Vite serves other files transformed, or not at all.
    if (relative(publicDir, path).startsWith("..")) {
      throw new GLTSError(`Helpers must be in the public directory: ${specifier}`, {
        importChain: [importerURL], phase: "resolve", url: importerURL,
      });
    }
    // The type check and the load report a missing helper, naming the script that imports it.
    return existsSync(path) ? readFile(path, "utf8") : undefined;
  };
  return { scripts: scripts.sort(), specifiers: await staticPackages(sources, readHelper) };
}
