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

export interface RewriteModuleOptions {
  readonly source: string;
  readonly sourceURL: string;
  readonly importChain: readonly string[];
  readonly resolveImport: StaticImportResolver;
}

function locationAt(source: string, offset: number): string {
  const before = source.slice(0, offset);
  const line = before.split("\n").length;
  const lastNewline = before.lastIndexOf("\n");
  const column = offset - lastNewline;
  return `${line}:${column}`;
}

export async function rewriteModule(options: RewriteModuleOptions): Promise<string> {
  let imports: ReturnType<typeof parse>[0];
  try {
    [imports] = parse(options.source, options.sourceURL);
  } catch (error) {
    throw new GLTSError("Unable to parse module imports", {
      url: options.sourceURL,
      phase: "transform",
      importChain: options.importChain
    }, error);
  }

  const rewritten = new MagicString(options.source, { filename: options.sourceURL });
  const staticImports = imports.filter((entry) => entry.t === staticImport);

  for (const entry of imports) {
    if (entry.t === importMeta) {
      continue;
    }

    if (entry.t !== staticImport) {
      throw new GLTSError(
        `Dynamic and source-phase imports are not supported (${locationAt(options.source, entry.ss)})`,
        {
          url: options.sourceURL,
          phase: "transform",
          importChain: options.importChain
        }
      );
    }

    if (entry.at) {
      throw new GLTSError(
        `Import attributes are not supported (${locationAt(options.source, entry.ss)})`,
        {
          url: options.sourceURL,
          phase: "transform",
          importChain: options.importChain
        }
      );
    }
  }

  // Resolve depth-first so a failed graph leaves no sibling work allocating
  // resources after execution cleanup.
  for (const entry of staticImports) {
    if (!entry.n) {
      throw new GLTSError(
        `Static import has no resolvable specifier (${locationAt(options.source, entry.ss)})`,
        {
          url: options.sourceURL,
          phase: "resolve",
          importChain: options.importChain
        }
      );
    }

    const resolved = await options.resolveImport(
      entry.n,
      options.sourceURL,
      options.importChain
    );
    rewritten.overwrite(entry.s, entry.e, resolved);
  }

  if (imports.some((entry) => entry.t === importMeta)) {
    const start = options.source.match(
      /^#![^\r\n\u2028\u2029]*(?:\r\n|[\r\n\u2028\u2029])/
    )?.[0].length ?? 0;
    rewritten.appendLeft(start, `import.meta.url = ${JSON.stringify(options.sourceURL)};\n`);
  }

  const safeSourceURL = options.sourceURL.replace(/[\n\r\u2028\u2029]/g, "");
  rewritten.append(`\n//# sourceURL=${safeSourceURL}\n`);
  return rewritten.toString();
}
