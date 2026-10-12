import type { Program } from "@babel/types";
import { glob, readFile } from "node:fs/promises";
import { resolve } from "node:path";
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

export interface Scan {
  /** The `.glts` files in the public directory. */
  readonly scripts: readonly string[];
  /** The bare specifiers the scripts import, sorted. */
  readonly specifiers: readonly string[];
}

/** The `.glts` files in the public directory, if any, and the packages they import. */
export async function scan(publicDir: string | undefined): Promise<Scan> {
  const scripts: string[] = [];
  if (publicDir) {
    for await (const path of glob("**/*.glts", { cwd: publicDir })) scripts.push(normalizePath(resolve(publicDir, path)));
  }
  const specifiers = new Set<string>();
  for (const file of scripts) {
    for (const specifier of importedSpecifiers(await readFile(file, "utf8"), file)) specifiers.add(specifier);
  }
  return { scripts: scripts.sort(), specifiers: [...specifiers].sort() };
}
