import { parse } from "es-module-lexer/js";
import MagicString from "magic-string";

import { GLTSError, type GLTSPhase } from "../errors.js";

const staticImport = 1;
const importMeta = 3;

/** A module's source, with the URL and import chain its errors report. */
export interface ModuleSource {
  readonly source: string;
  readonly url: string;
  readonly importChain: readonly string[];
}

interface StaticImport {
  readonly specifier: string;
  readonly start: number;
  readonly end: number;
}

interface ParsedModule {
  readonly imports: readonly StaticImport[];
  readonly usesImportMeta: boolean;
}

function locationAt(source: string, offset: number): string {
  const before = source.slice(0, offset);
  const line = before.split("\n").length;
  const lastNewline = before.lastIndexOf("\n");
  const column = offset - lastNewline;
  return `${line}:${column}`;
}

function parseModule({ source, url, importChain }: ModuleSource): ParsedModule {
  const failure = (message: string, phase: GLTSPhase, cause?: unknown): GLTSError =>
    new GLTSError(message, { importChain, phase, url }, cause);
  let entries: ReturnType<typeof parse>[0];
  try {
    [entries] = parse(source, url);
  } catch (error) {
    throw failure("Unable to parse module imports", "transform", error);
  }

  const imports: StaticImport[] = [];
  for (const entry of entries) {
    if (entry.t === importMeta) {
      continue;
    }

    if (entry.t !== staticImport) {
      throw failure(`Dynamic and source-phase imports are not supported (${locationAt(source, entry.ss)})`, "transform");
    }

    if (entry.at) {
      throw failure(`Import attributes are not supported (${locationAt(source, entry.ss)})`, "transform");
    }

    if (!entry.n) {
      throw failure(`Static import has no resolvable specifier (${locationAt(source, entry.ss)})`, "resolve");
    }

    imports.push({ specifier: entry.n, start: entry.s, end: entry.e });
  }

  return { imports, usesImportMeta: entries.some((entry) => entry.t === importMeta) };
}

/** The specifiers of a module's static imports, in source order. */
export function importSpecifiers(module: ModuleSource): string[] {
  return parseModule(module).imports.map(({ specifier }) => specifier);
}

export async function rewriteModule(
  module: ModuleSource,
  resolveImport: (specifier: string) => Promise<string>,
): Promise<string> {
  const { imports, usesImportMeta } = parseModule(module);
  const rewritten = new MagicString(module.source, { filename: module.url });

  // Resolve depth-first so a failed graph leaves no sibling work allocating
  // resources after execution cleanup.
  for (const { specifier, start, end } of imports) {
    rewritten.overwrite(start, end, await resolveImport(specifier));
  }

  if (usesImportMeta) {
    const start = module.source.match(
      /^#![^\r\n\u2028\u2029]*(?:\r\n|[\r\n\u2028\u2029])/
    )?.[0].length ?? 0;
    rewritten.appendLeft(start, `import.meta.url = ${JSON.stringify(module.url)};\n`);
  }

  const safeURL = module.url.replace(/[\n\r\u2028\u2029]/g, "");
  rewritten.append(`\n//# sourceURL=${safeURL}\n`);
  return rewritten.toString();
}
