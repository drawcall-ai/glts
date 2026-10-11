import { generate } from "@babel/generator";
import { parse } from "@babel/parser";
import {
  arrowFunctionExpression,
  awaitExpression,
  blockStatement,
  callExpression,
  expressionStatement,
  type ImportDeclaration,
  type Program,
  type Statement
} from "@babel/types";
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

export function validateScript(source: string, context: CompilationContext): ReturnType<typeof parse> {
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
    module = validateScript(source, context);
  } catch (error) {
    throw toGLTSError(error, "Invalid GLTS script", {
      ...context,
      phase: "transform"
    });
  }

  try {
    isolateScriptBody(module.program);
    const generated = generate(module.program, { retainLines: true }, source).code;
    return transform(generated, {
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
 * Browsers retain evaluated modules for the page's lifetime. Keep imports at
 * module scope, but put script state in a function that disposal can release.
 */
function isolateScriptBody(program: Program): void {
  const imports: ImportDeclaration[] = [];
  const statements: Statement[] = [];
  for (const statement of program.body) {
    if (statement.type === "ImportDeclaration") {
      imports.push(statement);
    } else {
      statements.push(statement);
    }
  }

  const body = blockStatement(statements, program.directives);
  const run = arrowFunctionExpression([], body, true);
  program.body = [...imports, expressionStatement(awaitExpression(callExpression(run, [])))];
  program.directives = [];
}
