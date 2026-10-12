import { generate } from "@babel/generator";
import { parse } from "@babel/parser";
import * as t from "@babel/types";
import { transform } from "sucrase";

import { GLTSError, toGLTSError } from "../errors.js";

interface CompilationContext {
  readonly importChain: readonly string[];
  readonly url: string;
}

/** Strips types, keeping every import as written, as TypeScript's verbatimModuleSyntax does. */
function stripTypes(source: string): string {
  return transform(source, { disableESTransforms: true, keepUnusedImports: true, transforms: ["typescript"] }).code;
}

export function compileScript(source: string, context: CompilationContext): string {
  try {
    const program = parseScript(source, context.url);
    isolateScriptBody(program, context);
    return stripTypes(generate(program, { retainLines: true }, source).code);
  } catch (error) {
    throw toGLTSError(error, "Unable to compile GLTS script", {
      ...context,
      phase: "transform"
    });
  }
}

export function compileHelper(source: string, context: CompilationContext): string {
  try {
    return stripTypes(source);
  } catch (error) {
    throw toGLTSError(error, "Unable to compile helper", {
      ...context,
      phase: "transform"
    });
  }
}

export function parseScript(source: string, url: string): t.Program {
  return parse(source, { plugins: ["typescript"], sourceFilename: url, sourceType: "module" }).program;
}

/**
 * Browsers retain evaluated modules for the page's lifetime. Keep imports at
 * module scope, but put script state in a function that disposal can release.
 */
function isolateScriptBody(program: t.Program, context: CompilationContext): void {
  if (program.body.some((statement) =>
    t.isExportDeclaration(statement) ||
    statement.type === "TSExportAssignment" ||
    statement.type === "TSNamespaceExportDeclaration"
  )) {
    throw new GLTSError("GLTS scripts must not export values", {
      ...context,
      phase: "transform"
    });
  }

  const imports = program.body.filter((statement) => statement.type === "ImportDeclaration");
  const statements = program.body.filter((statement) => statement.type !== "ImportDeclaration");
  const body = t.blockStatement(statements, program.directives);
  const run = t.arrowFunctionExpression([], body, true);
  program.body = [...imports, t.expressionStatement(t.awaitExpression(t.callExpression(run, [])))];
  program.directives = [];
}
