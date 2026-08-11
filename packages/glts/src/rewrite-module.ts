import { ImportType, init, parse } from "es-module-lexer";
import MagicString from "magic-string";

import { GLTSError } from "./errors.js";

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
  await init;

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
  const staticImports = imports.filter((entry) => entry.t === ImportType.Static);

  for (const entry of imports) {
    if (entry.t === ImportType.ImportMeta) {
      const suffix = options.source.slice(entry.e, entry.e + 4);
      if (suffix === ".url") {
        rewritten.overwrite(entry.s, entry.e + 4, JSON.stringify(options.sourceURL));
      }
      continue;
    }

    if (entry.t !== ImportType.Static) {
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

  const resolutions = await Promise.all(
    staticImports.map(async (entry) => {
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
      return { entry, resolved };
    })
  );

  for (const resolution of resolutions) {
    rewritten.overwrite(resolution.entry.s, resolution.entry.e, resolution.resolved);
  }

  const safeSourceURL = options.sourceURL.replaceAll("\n", "").replaceAll("\r", "");
  rewritten.append(`\n//# sourceURL=${safeSourceURL}\n`);
  return rewritten.toString();
}
