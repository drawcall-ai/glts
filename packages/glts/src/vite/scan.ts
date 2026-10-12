import { existsSync } from "node:fs";
import { glob, readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { normalizePath } from "vite";

import { compileHelper, compileScript } from "../modules/compiler.js";
import { assertScriptImport, helperURL, isBareSpecifier } from "../modules/resolution.js";
import { importSpecifiers } from "../modules/rewrite.js";

// Every loader provides these itself.
const provided = new Set(["@drawcall/glts", "three"]);

/** The specifiers a script or helper imports at runtime, as the loader reads them. */
async function runtimeImports(file: string, url: string): Promise<string[]> {
  const source = await readFile(file, "utf8");
  const compiled = extname(file) === ".glts" ? compileScript(source, url) : compileHelper(source, url, [url]);
  return importSpecifiers({ source: compiled, url, importChain: [url] });
}

export interface Scan {
  /** The `.glts` files in the public directory. */
  readonly scripts: readonly string[];
  /** The bare specifiers the scripts and their helpers import, except loader-provided ones, sorted. */
  readonly specifiers: readonly string[];
}

/** The `.glts` files in the public directory, if any, and the packages they and their helpers import. */
export async function scan(publicDir: string | undefined): Promise<Scan> {
  const scripts: string[] = [];
  if (publicDir) {
    for await (const path of glob("**/*.glts", { cwd: publicDir })) scripts.push(normalizePath(resolve(publicDir, path)));
  }
  const specifiers = new Set<string>();
  const files = [...scripts];
  // Grows while it is iterated, as helpers import more helpers.
  for (const file of files) {
    const url = pathToFileURL(file).href;
    for (const specifier of await runtimeImports(file, url)) {
      const helper = helperURL(specifier, url);
      if (helper) {
        const path = normalizePath(fileURLToPath(helper));
        // The type check and the load report a missing helper, naming the script that imports it.
        if (!files.includes(path) && existsSync(path)) files.push(path);
        continue;
      }
      // The type check resolves ./x.js and ./x to x.ts, but the loader only accepts helpers.
      assertScriptImport(specifier, url, [url]);
      if (isBareSpecifier(specifier) && !provided.has(specifier)) specifiers.add(specifier);
    }
  }
  return { scripts: scripts.sort(), specifiers: [...specifiers].sort() };
}
