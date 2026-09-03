import { parse } from "@babel/parser";

import { GLTSError } from "./errors.js";

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

interface ScriptContext {
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

export function validateScript(source: string, context: ScriptContext): void {
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
