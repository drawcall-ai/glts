import { parse } from "es-module-lexer/js";
import MagicString from "magic-string";

import { GLTSError } from "../errors.js";

const staticImport = 1;
const importMeta = 3;

export type StaticImportResolver = (
  specifier: string,
  importerURL: string,
  importChain: readonly string[]
) => Promise<string>;

interface ModuleSource {
  readonly source: string;
  readonly sourceURL: string;
  readonly importChain: readonly string[];
}

export interface RewriteModuleOptions extends ModuleSource {
  readonly resolveImport: StaticImportResolver;
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

function parseModule({ source, sourceURL, importChain }: ModuleSource): ParsedModule {
  let entries: ReturnType<typeof parse>[0];
  try {
    [entries] = parse(source, sourceURL);
  } catch (error) {
    throw new GLTSError("Unable to parse module imports", {
      url: sourceURL,
      phase: "transform",
      importChain
    }, error);
  }

  const imports: StaticImport[] = [];
  for (const entry of entries) {
    if (entry.t === importMeta) {
      continue;
    }

    if (entry.t !== staticImport) {
      throw new GLTSError(`Dynamic and source-phase imports are not supported (${locationAt(source, entry.ss)})`, {
        url: sourceURL,
        phase: "transform",
        importChain
      });
    }

    if (entry.at) {
      throw new GLTSError(`Import attributes are not supported (${locationAt(source, entry.ss)})`, {
        url: sourceURL,
        phase: "transform",
        importChain
      });
    }

    if (!entry.n) {
      throw new GLTSError(`Static import has no resolvable specifier (${locationAt(source, entry.ss)})`, {
        url: sourceURL,
        phase: "resolve",
        importChain
      });
    }

    imports.push({ specifier: entry.n, start: entry.s, end: entry.e });
  }

  return { imports, usesImportMeta: entries.some((entry) => entry.t === importMeta) };
}

/** The specifiers of a module's static imports, in source order. */
export function importSpecifiers(module: ModuleSource): string[] {
  return parseModule(module).imports.map(({ specifier }) => specifier);
}

export async function rewriteModule(options: RewriteModuleOptions): Promise<string> {
  const { imports, usesImportMeta } = parseModule(options);
  const rewritten = new MagicString(options.source, { filename: options.sourceURL });

  // Resolve depth-first so a failed graph leaves no sibling work allocating
  // resources after execution cleanup.
  for (const { specifier, start, end } of imports) {
    const resolved = await options.resolveImport(
      specifier,
      options.sourceURL,
      options.importChain
    );
    rewritten.overwrite(start, end, resolved);
  }

  if (usesImportMeta) {
    const start = options.source.match(
      /^#![^\r\n\u2028\u2029]*(?:\r\n|[\r\n\u2028\u2029])/
    )?.[0].length ?? 0;
    rewritten.appendLeft(start, `import.meta.url = ${JSON.stringify(options.sourceURL)};\n`);
  }

  const safeSourceURL = options.sourceURL.replace(/[\n\r\u2028\u2029]/g, "");
  rewritten.append(`\n//# sourceURL=${safeSourceURL}\n`);
  return rewritten.toString();
}
