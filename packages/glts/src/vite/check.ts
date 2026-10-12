import { stripVTControlCharacters } from "node:util";
import type * as TS from "typescript";

const required = "Type checking .glts scripts requires typescript 5 or 6 in the app's devDependencies";
const shim = "/glts-untyped.d.ts";
/** Every file but the scripts (libraries and package types), parsed once per process, since checks
 * run on Vite's event loop; a package rebuilt during development needs a restart. */
const parsed = new Map<string, TS.SourceFile>();

async function typescript(): Promise<typeof TS> {
  const { default: ts } = await import("typescript").catch((error: unknown) => {
    throw new Error(required, { cause: error });
  });
  // TypeScript 7 has no JavaScript API.
  if (typeof ts?.createProgram !== "function") throw new Error(required);
  return ts;
}

/** The type errors in the scripts, formatted like tsc's, or undefined when there are none. */
export async function check(scripts: readonly string[]): Promise<string | undefined> {
  if (scripts.length === 0) return;
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
    // Reads .glts files as TypeScript, as typescript-eslint and Volar do.
    allowNonTsExtensions: true,
  };
  const host = ts.createCompilerHost(options);
  const { getSourceFile, readFile } = host;
  // Packages that resolve keep their types; CDN packages and URL imports are untyped.
  host.readFile = (file) => file === shim ? `declare module "*";` : readFile(file);
  host.getSourceFile = (file, ...rest) => {
    if (file === shim || scripts.includes(file)) return getSourceFile(file, ...rest);
    const source = parsed.get(file) ?? getSourceFile(file, ...rest);
    if (source) parsed.set(file, source);
    return source;
  };
  const diagnostics = ts.getPreEmitDiagnostics(ts.createProgram([...scripts, shim], options, host));
  if (diagnostics.length === 0) return;
  // The only formatter with code frames always colors them.
  return stripVTControlCharacters(ts.formatDiagnosticsWithColorAndContext(diagnostics, host));
}
