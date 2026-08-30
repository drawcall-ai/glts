import { parse } from "@babel/parser";
import { traverseFast, type ImportDeclaration, type Node } from "@babel/types";

import { GLTSError } from "./errors.js";

export interface SourceRange {
  readonly start: number;
  readonly end: number;
}

export interface LocalImport extends SourceRange {
  readonly local: string;
  readonly url: URL;
}

export type ExternalImport =
  | {
      readonly kind: "side-effect";
      readonly path: string;
      readonly source: string;
    }
  | {
      readonly kind: "binding";
      readonly imported: string;
      readonly local: string;
      readonly path: string;
      readonly source: string;
      readonly typeOnly: boolean;
    };

export type DefaultClass =
  | {
      readonly kind: "named";
      readonly classStart: number;
      readonly exportStart: number;
      readonly name: string;
    }
  | {
      readonly kind: "anonymous";
      readonly classEnd: number;
      readonly classStart: number;
      readonly exportStart: number;
    };

export interface EntryModule {
  readonly externals: readonly ExternalImport[];
  readonly imports: readonly LocalImport[];
  readonly insertAt: number;
  readonly source: string;
}

export interface DependencyModule {
  readonly defaultClass: DefaultClass;
  readonly externals: readonly ExternalImport[];
  readonly imports: readonly LocalImport[];
  readonly metaURLs: readonly SourceRange[];
  readonly metaURL: string;
  readonly path: string;
  readonly removals: readonly SourceRange[];
  readonly source: string;
  readonly url: URL;
}

interface ModuleOptions {
  readonly path: string;
  readonly resolveImport: (specifier: string) => URL | undefined;
  readonly source: string;
}

interface DependencyModuleOptions extends ModuleOptions {
  readonly metaURL: string;
  readonly url: URL;
}

interface ParsedModule {
  readonly ast: ReturnType<typeof parse>;
  readonly externals: readonly ExternalImport[];
  readonly importRanges: readonly SourceRange[];
  readonly imports: readonly LocalImport[];
  readonly insertAt: number;
}

const previewExportNames: ReadonlySet<string> = new Set([
  "previewCamera",
  "previewLighting"
]);

export function failInline(
  message: string,
  path: string,
  phase: "resolve" | "transform",
  importChain: readonly string[] = [],
  cause?: unknown
): never {
  throw new GLTSError(message, { url: path, phase, importChain }, cause);
}

function sourceRange(node: Node, path: string): SourceRange {
  if (typeof node.start !== "number" || typeof node.end !== "number") {
    failInline("Parser returned a node without a source range", path, "transform");
  }

  return { start: node.start, end: node.end };
}

function parseModule(source: string, path: string): ReturnType<typeof parse> {
  try {
    return parse(source, {
      plugins: [
        "decorators-legacy",
        "deferredImportEvaluation",
        "sourcePhaseImports",
        "typescript"
      ],
      sourceFilename: path,
      sourceType: "module"
    });
  } catch (error) {
    failInline("Unable to parse TypeScript source", path, "transform", [], error);
  }
}

function metaURLRanges(
  ast: ReturnType<typeof parse>,
  path: string
): readonly SourceRange[] {
  const importMetas = new Set<Node>();
  const metaURLs = new Map<Node, SourceRange>();

  traverseFast(ast, (node) => {
    if (node.type === "ImportExpression") {
      failInline("Dynamic imports are not supported", path, "transform");
    }

    if (
      node.type === "MetaProperty" &&
      node.meta.name === "import" &&
      node.property.name === "meta"
    ) {
      importMetas.add(node);
      return;
    }

    if (
      node.type !== "MemberExpression" ||
      node.computed ||
      node.object.type !== "MetaProperty" ||
      node.object.meta.name !== "import" ||
      node.object.property.name !== "meta" ||
      node.property.type !== "Identifier" ||
      node.property.name !== "url"
    ) {
      return;
    }

    metaURLs.set(node.object, sourceRange(node, path));
  });

  for (const meta of importMetas) {
    if (!metaURLs.has(meta)) {
      failInline("Only import.meta.url is supported", path, "transform");
    }
  }

  return [...metaURLs.values()];
}

function importType(node: ImportDeclaration, path: string): "type" | "value" {
  if (node.importKind === "typeof") {
    failInline("Typeof imports are not supported", path, "transform");
  }

  return node.importKind === "type" ? "type" : "value";
}

function validateImport(node: ImportDeclaration, path: string): void {
  if (node.attributes && node.attributes.length > 0) {
    failInline("Import attributes are not supported", path, "transform");
  }

  if (node.module || node.phase) {
    failInline("Source-phase and deferred imports are not supported", path, "transform");
  }
}

function externalImports(
  node: ImportDeclaration,
  path: string
): readonly ExternalImport[] {
  const source = node.source.value;
  if (node.specifiers.length === 0) {
    return [{ kind: "side-effect", path, source }];
  }

  const declarationType = importType(node, path);
  return node.specifiers.map((specifier): ExternalImport => {
    if (specifier.type === "ImportDefaultSpecifier") {
      return {
        kind: "binding",
        imported: "default",
        local: specifier.local.name,
        path,
        source,
        typeOnly: declarationType === "type"
      };
    }

    if (specifier.type === "ImportNamespaceSpecifier") {
      return {
        kind: "binding",
        imported: "*",
        local: specifier.local.name,
        path,
        source,
        typeOnly: declarationType === "type"
      };
    }

    if (specifier.importKind === "typeof") {
      failInline("Typeof imports are not supported", path, "transform");
    }

    return {
      kind: "binding",
      imported: specifier.imported.type === "Identifier"
        ? specifier.imported.name
        : specifier.imported.value,
      local: specifier.local.name,
      path,
      source,
      typeOnly: declarationType === "type" || specifier.importKind === "type"
    };
  });
}

function localImport(
  node: ImportDeclaration,
  url: URL,
  path: string
): LocalImport {
  if (
    node.importKind === "type" ||
    node.specifiers.length !== 1 ||
    node.specifiers[0]?.type !== "ImportDefaultSpecifier"
  ) {
    failInline("Local GLTS imports must be default imports", path, "transform");
  }

  return {
    ...sourceRange(node, path),
    local: node.specifiers[0].local.name,
    url
  };
}

function parseImports(
  options: ModuleOptions,
  externalSyntax: "preserve" | "validate"
): ParsedModule {
  const ast = parseModule(options.source, options.path);
  const imports: LocalImport[] = [];
  const externals: ExternalImport[] = [];
  const importRanges: SourceRange[] = [];
  const firstNode = ast.program.body[0];
  let insertAt = firstNode
    ? sourceRange(firstNode, options.path).start
    : options.source.length;
  let bodyStarted = false;

  for (const node of ast.program.body) {
    if (node.type !== "ImportDeclaration") {
      bodyStarted = true;
      continue;
    }

    const nodeRange = sourceRange(node, options.path);
    importRanges.push(nodeRange);
    if (!bodyStarted) {
      insertAt = nodeRange.end;
    }

    const target = options.resolveImport(node.source.value);
    if (externalSyntax === "validate" || target) {
      validateImport(node, options.path);
    }
    if (target) {
      imports.push(localImport(node, target, options.path));
    } else {
      externals.push(...externalImports(node, options.path));
    }
  }

  return { ast, externals, importRanges, imports, insertAt };
}

function readDefaultClass(
  node: Extract<Node, { type: "ExportDefaultDeclaration" }>,
  path: string
): DefaultClass {
  if (node.declaration.type !== "ClassDeclaration") {
    failInline("Inlined dependencies must default-export a class", path, "transform");
  }

  const exportRange = sourceRange(node, path);
  const classRange = sourceRange(node.declaration, path);
  if (node.declaration.id) {
    return {
      kind: "named",
      classStart: classRange.start,
      exportStart: exportRange.start,
      name: node.declaration.id.name
    };
  }

  return {
    kind: "anonymous",
    classEnd: classRange.end,
    classStart: classRange.start,
    exportStart: exportRange.start
  };
}

function validatePreviewNames(names: readonly string[], path: string): void {
  if (names.length > 0 && names.every((name) => previewExportNames.has(name))) {
    return;
  }

  failInline(
    "Inlined dependencies may only have a default export or named preview exports",
    path,
    "transform"
  );
}

function readPreviewExport(
  node: Extract<Node, { type: "ExportNamedDeclaration" }>,
  path: string
): SourceRange {
  if (node.source || node.exportKind === "type") {
    failInline(
      "Inlined dependencies may only have a default export or named preview exports",
      path,
      "transform"
    );
  }

  const exportRange = sourceRange(node, path);
  if (node.declaration) {
    if (node.declaration.type !== "VariableDeclaration") {
      failInline(
        "Inlined preview exports must be variable declarations",
        path,
        "transform"
      );
    }

    const names = node.declaration.declarations.map((declaration) => {
      if (declaration.id.type !== "Identifier") {
        failInline(
          "Inlined preview exports must use identifier bindings",
          path,
          "transform"
        );
      }
      return declaration.id.name;
    });
    validatePreviewNames(names, path);

    const declarationRange = sourceRange(node.declaration, path);
    return {
      start: exportRange.start,
      end: declarationRange.start
    };
  }

  const names = node.specifiers.map((specifier) => {
    if (specifier.type !== "ExportSpecifier" || specifier.exportKind === "type") {
      failInline("Inlined preview exports must be runtime value exports", path, "transform");
    }
    return specifier.exported.type === "Identifier"
      ? specifier.exported.name
      : specifier.exported.value;
  });
  validatePreviewNames(names, path);

  return exportRange;
}

export function analyzeEntryModule(options: ModuleOptions): EntryModule {
  const parsed = parseImports(options, "preserve");
  for (const node of parsed.ast.program.body) {
    if (
      (node.type === "ExportNamedDeclaration" || node.type === "ExportAllDeclaration") &&
      node.source &&
      options.resolveImport(node.source.value)
    ) {
      failInline("Local GLTS re-exports are not supported", options.path, "transform");
    }
  }

  return {
    externals: parsed.externals,
    imports: parsed.imports,
    insertAt: parsed.insertAt,
    source: options.source
  };
}

export function analyzeDependencyModule(
  options: DependencyModuleOptions
): DependencyModule {
  const parsed = parseImports(options, "validate");
  const previewRemovals: SourceRange[] = [];
  let defaultClass: DefaultClass | undefined;

  for (const node of parsed.ast.program.body) {
    if (node.type === "ImportDeclaration") {
      continue;
    }

    if (node.type === "TSImportEqualsDeclaration") {
      failInline(
        "TypeScript import-equals declarations are not supported",
        options.path,
        "transform"
      );
    }

    if (node.type === "ExportDefaultDeclaration") {
      if (defaultClass) {
        failInline(
          "Inlined dependency has more than one default export",
          options.path,
          "transform"
        );
      }

      defaultClass = readDefaultClass(node, options.path);
      continue;
    }

    if (node.type === "ExportNamedDeclaration") {
      previewRemovals.push(readPreviewExport(node, options.path));
      continue;
    }

    if (
      node.type === "ExportAllDeclaration" ||
      node.type === "TSExportAssignment" ||
      node.type === "TSNamespaceExportDeclaration"
    ) {
      failInline(
        "Inlined dependencies may only have a default export",
        options.path,
        "transform"
      );
    }
  }

  if (!defaultClass) {
    failInline("Inlined dependency must have a default export", options.path, "transform");
  }

  return {
    defaultClass,
    externals: parsed.externals,
    imports: parsed.imports,
    metaURLs: metaURLRanges(parsed.ast, options.path),
    metaURL: options.metaURL,
    path: options.path,
    removals: [...parsed.importRanges, ...previewRemovals],
    source: options.source,
    url: options.url
  };
}

export function validateInlineSyntax(source: string): void {
  parseModule(source, "<inline output>");
}
