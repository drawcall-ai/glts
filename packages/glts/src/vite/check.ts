import { posix } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type * as TS from "typescript";

type TypeScript = typeof TS;

async function typescript(): Promise<TypeScript> {
  try {
    return (await import("typescript")).default;
  } catch (error) {
    throw new Error("Type checking .glts scripts requires typescript; add it to the app's devDependencies", { cause: error });
  }
}

export interface CheckOptions {
  /** The Vite root, which holds the generated declarations. */
  readonly root: string;
  /** The `.glts` files to check. */
  readonly scripts: readonly string[];
  /** The packages scripts import from the CDN, which have no local types. */
  readonly untyped: readonly string[];
}

/** Returns the type errors in the scripts, formatted like tsc's, or undefined when there are none. */
export type Check = (options: CheckOptions) => Promise<string | undefined>;

/**
 * Creates a check that reuses the libraries and package types it parsed in
 * earlier runs, so rechecking edited scripts stays fast. Changes to those
 * files need a new check.
 */
export function checker(): Check {
  const parsed = new Map<string, TS.SourceFile>();
  let previous: TS.Program | undefined;

  return async ({ root, scripts, untyped }) => {
    const ts = await typescript();
    // Scripts run in one fixed browser runtime, not as part of the app's TypeScript project. They may use
    // top-level await without imports, and import packages like Vite resolves them.
    const options: TS.CompilerOptions = {
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      target: ts.ScriptTarget.ES2022,
      moduleDetection: ts.ModuleDetectionKind.Force,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
    };
    // TypeScript only reads its own extensions, so each script poses as a .ts file, as svelte-check does.
    const real = new Map(scripts.map((script) => [`${script}.ts`, script]));
    const shims = posix.join(root, "glts-untyped.d.ts");
    const declarations = [...untyped, "https://*", "http://*"]
      .map((specifier) => `declare module ${JSON.stringify(specifier)};`).join("\n");

    const host = ts.createCompilerHost(options);
    host.readFile = (file) => file === shims ? declarations : ts.sys.readFile(real.get(file) ?? file);
    const { getSourceFile } = host;
    host.getSourceFile = (file, version, onError, fresh) => {
      if (real.has(file) || file === shims) return getSourceFile(file, version, onError, fresh);
      const source = parsed.get(file) ?? getSourceFile(file, version, onError, fresh);
      if (source) parsed.set(file, source);
      return source;
    };
    const program = ts.createProgram([...real.keys(), shims], options, host, previous);
    previous = program;
    const diagnostics = ts.getPreEmitDiagnostics(program);
    if (diagnostics.length === 0) return;

    // Diagnostics name the real scripts.
    const sources = new Map(program.getSourceFiles().flatMap((file) => {
      const script = real.get(file.fileName);
      return script ? [[file, ts.createSourceFile(script, file.text, ts.ScriptTarget.Latest)]] : [];
    }));
    const located = <T extends TS.DiagnosticRelatedInformation>(diagnostic: T): T =>
      ({ ...diagnostic, file: diagnostic.file && (sources.get(diagnostic.file) ?? diagnostic.file) });
    // The only formatter with code frames always colors them.
    return stripVTControlCharacters(ts.formatDiagnosticsWithColorAndContext(diagnostics.map((diagnostic) => ({
      ...located(diagnostic),
      ...diagnostic.relatedInformation && { relatedInformation: diagnostic.relatedInformation.map(located) },
    })), host));
  };
}
