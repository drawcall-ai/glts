import { stripVTControlCharacters } from "node:util";
import { fileURLToPath } from "node:url";
import type * as TS from "typescript";

const missingTypeScript = "Type checking .glts scripts requires typescript 5 or 6 in the app's devDependencies";
const shimPath = "/glts-untyped.d.ts";
// Use the installed Vite's declarations for import.meta.env rather than copying its contract.
const importMetaTypes = fileURLToPath(new URL("./types/importMeta.d.ts", import.meta.resolve("vite/package.json")));
/** Types every package and URL import, but no relative one, so a missing helper is still an error. Module
 * patterns have one wildcard, so this declares one per first character a package name or URL can have. */
const shimSource = [..."@0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"].map((first) => `declare module "${first}*";`).join("\n");
/** Files in node_modules (libraries and package types), parsed once per process, since checks run on
 * Vite's event loop; a package rebuilt during development needs a restart. */
const libraryFiles = new Map<string, TS.SourceFile>();

async function loadTypeScript(): Promise<typeof TS> {
  const { default: ts } = await import("typescript").catch((error: unknown) => {
    throw new Error(missingTypeScript, { cause: error });
  });
  // TypeScript 7 has no JavaScript API.
  if (typeof ts?.createProgram !== "function") throw new Error(missingTypeScript);
  return ts;
}

/** The type errors in the scripts, formatted like tsc's, or undefined when there are none. */
export async function typecheck(scripts: readonly string[]): Promise<string | undefined> {
  if (scripts.length === 0) return;
  const ts = await loadTypeScript();
  // Scripts run in one fixed browser environment, not as part of the app's TypeScript project. They may use
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
    // Helpers are imported by their URL, extension included.
    allowImportingTsExtensions: true,
  };
  const host = ts.createCompilerHost(options);
  const { getSourceFile, readFile } = host;
  // Packages that resolve keep their types; CDN packages and URL imports are untyped.
  host.readFile = (file) => file === shimPath ? shimSource : readFile(file);
  host.getSourceFile = (file, ...rest) => {
    if (file === shimPath || !file.includes("/node_modules/")) return getSourceFile(file, ...rest);
    const sourceFile = libraryFiles.get(file) ?? getSourceFile(file, ...rest);
    if (sourceFile) libraryFiles.set(file, sourceFile);
    return sourceFile;
  };
  const diagnostics = ts.getPreEmitDiagnostics(ts.createProgram([...scripts, shimPath, importMetaTypes], options, host));
  if (diagnostics.length === 0) return;
  // The only formatter with code frames always colors them.
  return stripVTControlCharacters(ts.formatDiagnosticsWithColorAndContext(diagnostics, host));
}
