import { parse } from "@babel/parser";
import { parse as parseImports } from "es-module-lexer/js";
import MagicString from "magic-string";
import { transform } from "sucrase";

import { GLTSError, toGLTSError } from "../errors.js";

const staticImport = 1;
const shebang = /^#![^\r\n\u2028\u2029]*(?:\r\n|[\r\n\u2028\u2029])/;

const contextImports = new Set([
  "gltsLoader",
  "instanceCount",
  "loadingManager",
  "onDispose",
  "onFrame",
  "onMatrixUpdateAt",
  "isPreview",
  "scene"
]);

interface CompilationContext {
  readonly importChain: readonly string[];
  readonly url: string;
}

interface ImportedIdentifier {
  readonly name: string;
  readonly type: "Identifier";
}

interface ImportedString {
  readonly type: "StringLiteral";
  readonly value: string;
}

function importedName(
  imported: ImportedIdentifier | ImportedString
): string {
  if (imported.type === "Identifier") {
    return imported.name;
  }

  return imported.value;
}

export function validateScript(source: string, context: CompilationContext): void {
  const module = parse(source, {
    plugins: ["typescript"],
    sourceFilename: context.url,
    sourceType: "module"
  });

  for (const statement of module.program.body) {
    if (
      statement.type.startsWith("Export") ||
      statement.type === "TSExportAssignment" ||
      statement.type === "TSNamespaceExportDeclaration"
    ) {
      throw new GLTSError("GLTS scripts must not export values", {
        ...context,
        phase: "transform"
      });
    }

    if (
      statement.type !== "ImportDeclaration"
    ) {
      continue;
    }

    if (statement.source.value.endsWith(".glts")) {
      throw new GLTSError(
        `Static GLTS imports are not supported: ${statement.source.value}; use gltsLoader.loadAsync()`,
        { ...context, phase: "transform" }
      );
    }

    if (
      statement.source.value !== "@drawcall/glts" ||
      statement.importKind === "type"
    ) {
      continue;
    }

    for (const specifier of statement.specifiers) {
      if (specifier.type !== "ImportSpecifier") {
        throw new GLTSError(
          "@drawcall/glts must use named imports inside a GLTS script",
          { ...context, phase: "transform" }
        );
      }

      if (specifier.importKind === "type") {
        continue;
      }

      const name = importedName(specifier.imported);
      if (name === "GLTSLoader") {
        throw new GLTSError(
          "GLTSLoader cannot be imported inside a GLTS script; import gltsLoader instead",
          { ...context, phase: "transform" }
        );
      }

      if (!contextImports.has(name)) {
        throw new GLTSError(`Unsupported @drawcall/glts script import: ${name}`, {
          ...context,
          phase: "transform"
        });
      }
    }
  }
}

export function compileScript(source: string, context: CompilationContext): string {
  try {
    validateScript(source, context);
  } catch (error) {
    throw toGLTSError(error, "Invalid GLTS script", {
      ...context,
      phase: "transform"
    });
  }

  try {
    return isolateScriptBody(transform(source, {
      disableESTransforms: true,
      keepUnusedImports: true,
      transforms: ["typescript"]
    }).code);
  } catch (error) {
    throw toGLTSError(error, "Unable to compile TypeScript script", {
      ...context,
      phase: "transform"
    });
  }
}

function isBlank(source: string): boolean {
  return source.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "").replace(/[\s;]/g, "") === "";
}

/**
 * Runs the script body inside an async function. Browsers keep evaluated
 * modules for the lifetime of the page, so state held by a script module's
 * top-level bindings could never be collected after the script is disposed.
 * Leading imports stay in place, so line numbers are unchanged; imports after
 * body code are hoisted above it.
 */
export function isolateScriptBody(source: string): string {
  const [imports] = parseImports(source);
  const staticImports = imports.filter((entry) => entry.t === staticImport);
  const code = new MagicString(source);

  let bodyStart = source.match(shebang)?.[0].length ?? 0;
  for (const entry of staticImports) {
    if (!isBlank(source.slice(bodyStart, entry.ss))) break;
    bodyStart = entry.se;
  }

  for (const entry of staticImports) {
    if (entry.ss < bodyStart) continue;
    code.appendRight(bodyStart, `;${source.slice(entry.ss, entry.se)}`);
    code.remove(entry.ss, entry.se);
  }

  code.appendRight(bodyStart, ";await (async () => {");
  code.append("\n})();");
  return code.toString();
}
