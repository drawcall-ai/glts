import { generate } from "@babel/generator";
import { parse } from "@babel/parser";
import * as t from "@babel/types";
import { transform } from "sucrase";

import { GLTSError, toGLTSError } from "../errors.js";

/** Strips types and, as TypeScript does, imports used only as types. */
function stripTypes(source: string): string {
  return transform(source, { disableESTransforms: true, transforms: ["typescript"] }).code;
}

export function compileScript(source: string, url: string): string {
  try {
    const { program } = parse(source, { plugins: ["typescript"], sourceFilename: url, sourceType: "module" });
    isolateScriptBody(program, url);
    return stripTypes(generate(program, { retainLines: true }, source).code);
  } catch (error) {
    throw toGLTSError(error, "Unable to compile GLTS script", {
      importChain: [url],
      phase: "transform",
      url
    });
  }
}

export function compileHelper(source: string, url: string, importChain: readonly string[]): string {
  try {
    return stripTypes(source);
  } catch (error) {
    throw toGLTSError(error, "Unable to compile helper", {
      importChain,
      phase: "transform",
      url
    });
  }
}

/**
 * Browsers retain evaluated modules for the page's lifetime. Keep imports at
 * module scope, but put script state in a function that disposal can release.
 */
function isolateScriptBody(program: t.Program, url: string): void {
  if (program.body.some((statement) =>
    t.isExportDeclaration(statement) ||
    statement.type === "TSExportAssignment" ||
    statement.type === "TSNamespaceExportDeclaration"
  )) {
    throw new GLTSError("GLTS scripts must not export values", {
      importChain: [url],
      phase: "transform",
      url
    });
  }

  const imports = program.body.filter((statement) => statement.type === "ImportDeclaration");
  const statements = program.body.filter((statement) => statement.type !== "ImportDeclaration");
  const body = t.blockStatement(statements, program.directives);
  const run = t.arrowFunctionExpression([], body, true);
  program.body = [...imports, t.expressionStatement(t.awaitExpression(t.callExpression(run, [])))];
  program.directives = [];
}
