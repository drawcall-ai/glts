import { parse } from "@babel/parser";
import MagicString from "magic-string";
import { transform } from "sucrase";

import { GLTSError, toGLTSError } from "../errors.js";

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
  parseAndValidateScript(source, context);
}

function parseAndValidateScript(source: string, context: CompilationContext): ReturnType<typeof parse> {
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
  return module;
}

export function compileScript(source: string, context: CompilationContext): string {
  let module: ReturnType<typeof parse>;
  try {
    module = parseAndValidateScript(source, context);
  } catch (error) {
    throw toGLTSError(error, "Invalid GLTS script", {
      ...context,
      phase: "transform"
    });
  }

  try {
    return transform(isolateScriptBody(source, module.program), {
      disableESTransforms: true,
      keepUnusedImports: true,
      transforms: ["typescript"]
    }).code;
  } catch (error) {
    throw toGLTSError(error, "Unable to compile TypeScript script", {
      ...context,
      phase: "transform"
    });
  }
}

/**
 * Runs the script body inside an async function. Browsers keep evaluated
 * modules for the lifetime of the page, so state held by a script module's
 * top-level bindings could never be collected after the script is disposed.
 * Leading imports stay in place, so line numbers are unchanged; imports after
 * body code are hoisted above it.
 */
function isolateScriptBody(source: string, program: ReturnType<typeof parse>["program"]): string {
  const firstBody = program.directives[0] ?? program.body.find((statement) =>
    statement.type !== "ImportDeclaration" && statement.type !== "EmptyStatement"
  );
  if (!firstBody) return source;

  const bodyStart = firstBody.start!;
  const code = new MagicString(source);
  for (const statement of program.body) {
    if (statement.type !== "ImportDeclaration" || statement.start! < bodyStart) continue;
    code.appendRight(bodyStart, `;${source.slice(statement.start!, statement.end!)}`);
    // Keep a separator so removing an import cannot join adjacent expressions.
    code.overwrite(statement.start!, statement.end!, ";");
  }

  code.appendRight(bodyStart, ";await (async () => {");
  code.append("\n})();");
  return code.toString();
}
