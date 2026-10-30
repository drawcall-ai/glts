import { disableScriptTags, transform, type registerPlugin } from "@babel/standalone";
import * as t from "@babel/types";

import { GLTSError, toGLTSError } from "../errors.js";
import { gltsSpecifier, importNames } from "../imports.js";

type Plugin = ReturnType<Parameters<typeof registerPlugin>[1]>;
type File = Parameters<NonNullable<Plugin["pre"]>>[0];

// Standalone is used only as a compiler; never execute host-page script tags.
if (typeof window !== "undefined") disableScriptTags();

export function compileScript(source: string, url: string): string {
  try {
    return compile(source, url, isolateScript(url));
  } catch (error) {
    throw toGLTSError(error, "Unable to compile GLTS script", { importChain: [url], phase: "transform", url });
  }
}

export function compileHelper(source: string, url: string, chain: readonly string[]): string {
  try {
    return compile(source, url);
  } catch (error) {
    throw toGLTSError(error, "Unable to compile helper", { importChain: chain, phase: "transform", url });
  }
}

/**
 * Strips types, as TypeScript does including imports used only as types; a script's isolation, which runs in the
 * preset's pass, sees the code without types.
 */
function compile(source: string, url: string, isolate?: Plugin): string {
  const result = transform(source, {
    sourceType: "module",
    filename: url,
    retainLines: true,
    passPerPreset: true,
    plugins: [dropInterpreter, rejectImportAssignments, "transform-typescript"],
    presets: [() => ({ plugins: isolate ? [() => isolate] : [] })],
  });
  if (typeof result?.code !== "string") throw new Error("GLTS compiler produced no code");
  return result.code;
}

/** A hashbang means nothing in a loaded module, and dropping it lets a prefix such as the precompiled marker come first. */
function dropInterpreter(): Plugin {
  return {
    name: "glts-drop-interpreter",
    pre(file) {
      file.path.node.interpreter = null;
    },
  };
}

/**
 * Stripping types drops an import that is only assigned, as if used only as a type, which turns the
 * assignment into a global write; so assignments to imports fail before it runs.
 */
function rejectImportAssignments(): Plugin {
  return {
    name: "glts-reject-import-assignments",
    pre(file) {
      for (const [name, binding] of Object.entries(file.scope.bindings)) {
        const [violation] = binding.constantViolations;
        if (binding.kind === "module" && violation) throw violation.buildCodeFrameError(`Cannot assign to import '${name}'`);
      }
    },
  };
}

/** Stripping types leaves `export {}` when a module exported only types, which exports no values. */
function isEmptyExport(statement: t.Statement): boolean {
  return t.isExportNamedDeclaration(statement) && !statement.declaration && !statement.source &&
    statement.specifiers.length === 0;
}

/**
 * Browsers retain evaluated modules for the page's lifetime. Keep imports at module scope, but put
 * script state in a default-exported function that disposal can release, called with the import namespace.
 */
function isolateScript(url: string): Plugin {
  return {
    name: "glts-isolate-script",
    pre(file) {
      const program = file.path.node;
      if (program.body.some((statement) => t.isExportDeclaration(statement) && !isEmptyExport(statement))) {
        throw new GLTSError("GLTS scripts must not export values", { importChain: [url], phase: "transform", url });
      }

      const namespace = bindImports(file);
      const meta = file.scope.generateUidIdentifier("meta");
      file.path.traverse({
        MetaProperty(path) {
          if (path.node.meta.name === "import") path.replaceWith(t.cloneNode(meta));
        },
      });
      const imports = program.body.filter((statement) => statement.type === "ImportDeclaration");
      const statements = program.body.filter((statement) => statement.type !== "ImportDeclaration" && !isEmptyExport(statement));
      const run = t.arrowFunctionExpression([namespace, meta], t.blockStatement(statements, program.directives), true);
      program.body = [...imports, t.exportDefaultDeclaration(run)];
      program.directives = [];
      file.scope.crawl();
    },
  };
}

/** Replaces `@drawcall/glts` imports with reads of the import namespace parameter it returns. */
function bindImports(file: File): t.Identifier {
  const namespace = file.scope.generateUidIdentifier("imports");
  for (const declaration of file.path.get("body")) {
    if (!declaration.isImportDeclaration() || declaration.node.source.value !== gltsSpecifier) continue;
    for (const specifier of declaration.node.specifiers) {
      const name = t.isImportSpecifier(specifier)
        ? t.isIdentifier(specifier.imported) ? specifier.imported.name : specifier.imported.value
        : t.isImportDefaultSpecifier(specifier) ? "default" : undefined;
      if (name !== undefined && !importNames.has(name)) {
        throw declaration.buildCodeFrameError(`${gltsSpecifier} does not provide a script export named '${name}'`);
      }
      const binding = file.scope.getBinding(specifier.local.name);
      if (!binding) throw new Error(`Missing import binding: ${specifier.local.name}`);
      for (const reference of binding.referencePaths) {
        const value = name === undefined
          ? t.cloneNode(namespace)
          : t.memberExpression(t.cloneNode(namespace), t.identifier(name));
        const parent = reference.parentPath;
        // An imported function is called without a receiver, unlike a namespace method.
        const unbound = name !== undefined && (
          ((parent.isCallExpression() || parent.isOptionalCallExpression()) && reference.key === "callee") ||
          (parent.isTaggedTemplateExpression() && reference.key === "tag")
        );
        if (parent.isObjectProperty() && parent.node.shorthand) parent.node.shorthand = false;
        reference.replaceWith(unbound ? t.sequenceExpression([t.numericLiteral(0), value]) : value);
      }
    }
    declaration.remove();
  }

  return namespace;
}
