// Parse compiled JavaScript synchronously without eval or WebAssembly.
import { parse } from "es-module-lexer/minimal/js";

import { GLTSError, type GLTSPhase } from "../errors.js";
import type { GLTSLoaderOptions } from "../types.js";
import type { Source } from "./fetch.js";

/** es-module-lexer's entry types. */
const staticEntry = 1;
const dynamicEntry = 2;
const metaEntry = 3;
/** Stands in for the `import` keyword of a module's dynamic imports. */
const dynamicImportBinding = "__glts_import";

interface StaticImport {
  readonly specifier: string;
  readonly start: number;
  readonly end: number;
}

interface DynamicImport {
  /** The literal specifier, or undefined when it is computed. */
  readonly specifier: string | undefined;
  /** Where the `import` keyword starts. */
  readonly start: number;
}

interface ParsedImports {
  readonly staticImports: readonly StaticImport[];
  readonly dynamicImports: readonly DynamicImport[];
  readonly usesImportMeta: boolean;
}

function locationAt(source: string, offset: number): string {
  const before = source.slice(0, offset);
  const line = before.split("\n").length;
  const lastNewline = before.lastIndexOf("\n");
  const column = offset - lastNewline;
  return `${line}:${column}`;
}

/** The imports of a compiled script, helper, or package module, rejecting those the linker cannot link. */
export function parseImports({ source, url }: Source, chain: readonly string[]): ParsedImports {
  const failure = (message: string, phase: GLTSPhase, cause?: unknown): GLTSError =>
    new GLTSError(message, { importChain: chain, phase, url }, cause);
  let entries: ReturnType<typeof parse>[0];
  try {
    [entries] = parse(source, url);
  } catch (error) {
    throw failure("Unable to parse module imports", "transform", error);
  }

  const staticImports: StaticImport[] = [];
  const dynamicImports: DynamicImport[] = [];
  for (const entry of entries) {
    if (entry.t === metaEntry) {
      continue;
    }

    if (entry.t === dynamicEntry) {
      if (entry.a !== -1) {
        throw failure(`Import attributes are not supported (${locationAt(source, entry.ss)})`, "transform");
      }
      dynamicImports.push({ specifier: entry.n, start: entry.ss });
      continue;
    }

    if (entry.t !== staticEntry) {
      throw failure(`Source- and defer-phase imports are not supported (${locationAt(source, entry.ss)})`, "transform");
    }

    if (entry.a !== -1) {
      throw failure(`Import attributes are not supported (${locationAt(source, entry.ss)})`, "transform");
    }

    if (!entry.n) {
      throw failure(`Static import has no resolvable specifier (${locationAt(source, entry.ss)})`, "resolve");
    }

    staticImports.push({ specifier: entry.n, start: entry.s, end: entry.e });
  }

  return { staticImports, dynamicImports, usesImportMeta: entries.some((entry) => entry.t === metaEntry) };
}

/**
 * Links a module's static imports through `link`. Its dynamic imports call the function whose source is
 * `dynamicImportSource` instead, which links each specifier when the import runs.
 */
export async function rewriteModule(
  { source, url }: Source,
  { staticImports, dynamicImports, usesImportMeta }: ParsedImports,
  link: (specifier: string) => Promise<string>,
  dynamicImportSource: () => string,
  env?: GLTSLoaderOptions["env"],
): Promise<string> {
  const edits: { start: number; end: number; text: string }[] = [];

  // Link depth-first so a failure leaves no sibling imports fetching.
  for (const { specifier, start, end } of staticImports) {
    edits.push({ start: start - 1, end: end + 1, text: JSON.stringify(await link(specifier)) });
  }

  const prologue: string[] = [];
  if (usesImportMeta) {
    prologue.push(`import.meta.url = ${JSON.stringify(url)};\n`);
    if (env !== undefined) {
      const entries = Object.entries(env).map(([key, value]) => `[${JSON.stringify(key)}]:${JSON.stringify(value)}`);
      prologue.push(`import.meta.env = {${entries.join(",")}};\n`);
    }
  }
  if (dynamicImports.length > 0) {
    // An identifier, unlike an inline expression, cannot join the previous line in code without semicolons.
    prologue.push(`const ${dynamicImportBinding} = ${dynamicImportSource()};\n`);
    for (const { start } of dynamicImports) edits.push({ start, end: start + "import".length, text: dynamicImportBinding });
  }
  // After a hashbang, which must stay first, and before an edit at the same offset.
  const prologueStart = source.match(/^#![^\r\n\u2028\u2029]*(?:\r\n|[\r\n\u2028\u2029])/)?.[0].length ?? 0;
  edits.push({ start: prologueStart, end: prologueStart, text: prologue.join("") });

  let rewritten = "";
  let position = 0;
  for (const { start, end, text } of edits.sort((a, b) => a.start - b.start || a.end - b.end)) {
    rewritten += source.slice(position, start) + text;
    position = end;
  }
  const safeURL = url.replace(/[\n\r\u2028\u2029]/g, "");
  return `${rewritten}${source.slice(position)}\n//# sourceURL=${safeURL}\n`;
}
