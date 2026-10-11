import { generate } from "@babel/generator";
import { parse } from "@babel/parser";
import * as t from "@babel/types";
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

export function compileScript(source: string, context: CompilationContext): string {
  try {
    const { program } = parse(source, {
      plugins: ["typescript"],
      sourceFilename: context.url,
      sourceType: "module"
    });
    validateScript(program, context);
    isolateScriptBody(program);
    return transform(generate(program, { retainLines: true }, source).code, {
      disableESTransforms: true,
      keepUnusedImports: true,
      transforms: ["typescript"]
    }).code;
  } catch (error) {
    throw toGLTSError(error, "Unable to compile GLTS script", {
      ...context,
      phase: "transform"
    });
  }
}

function validateScript(program: t.Program, context: CompilationContext): void {
  for (const statement of program.body) {
    if (
      t.isExportDeclaration(statement) ||
      statement.type === "TSExportAssignment" ||
      statement.type === "TSNamespaceExportDeclaration"
    ) {
      throw new GLTSError("GLTS scripts must not export values", {
        ...context,
        phase: "transform"
      });
    }

    if (statement.type !== "ImportDeclaration") {
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

      const name = specifier.imported.type === "Identifier"
        ? specifier.imported.name
        : specifier.imported.value;
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

/**
 * Browsers retain evaluated modules for the page's lifetime. Keep imports at
 * module scope, but put script state in a function that disposal can release.
 */
function isolateScriptBody(program: t.Program): void {
  const imports = program.body.filter((statement) => statement.type === "ImportDeclaration");
  const statements = program.body.filter((statement) => statement.type !== "ImportDeclaration");
  const body = t.blockStatement(statements, program.directives);
  const run = t.arrowFunctionExpression([], body, true);
  program.body = [...imports, t.expressionStatement(t.awaitExpression(t.callExpression(run, [])))];
  program.directives = [];
}
