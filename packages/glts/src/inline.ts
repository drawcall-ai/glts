import { parse } from "@babel/parser";
import { traverseFast, type ImportDeclaration, type Node } from "@babel/types";
import MagicString from "magic-string";

import { GLTSError } from "./errors.js";

const entryURL = new URL("glts://inline/entry.glts");

interface Range {
  readonly start: number;
  readonly end: number;
}

interface Source {
  readonly path: string;
  readonly source: string;
  readonly url: URL;
  readonly metaURL: string;
}

interface LocalImport extends Range {
  readonly local: string;
  readonly url: URL;
}

type ExternalImport =
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

type DefaultClass =
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

interface File {
  readonly defaultClass?: DefaultClass;
  readonly externals: readonly ExternalImport[];
  readonly importRanges: readonly Range[];
  readonly imports: readonly LocalImport[];
  readonly insertAt: number;
  readonly metaURLs: readonly Range[];
  readonly metaURL: string;
  readonly path: string;
  readonly source: string;
  readonly url: URL;
}

function fail(
  message: string,
  path: string,
  phase: "resolve" | "transform",
  importChain: readonly string[] = [],
  cause?: unknown
): never {
  throw new GLTSError(message, { url: path, phase, importChain }, cause);
}

function range(node: Node, path: string): Range {
  if (typeof node.start !== "number" || typeof node.end !== "number") {
    fail("Parser returned a node without a source range", path, "transform");
  }

  return { start: node.start, end: node.end };
}

function isBare(specifier: string): boolean {
  return (
    !specifier.startsWith(".") &&
    !specifier.startsWith("/") &&
    !/^[A-Za-z][A-Za-z\d+.-]*:/.test(specifier)
  );
}

function displayURL(url: URL): string {
  if (url.protocol !== entryURL.protocol || url.host !== entryURL.host) {
    return url.href;
  }

  return `.${url.pathname}${url.search}${url.hash}`;
}

function sourceMap(files: Readonly<Record<string, string>>): Map<string, Source> {
  const sources = new Map<string, Source>();

  for (const [path, source] of Object.entries(files)) {
    if (path.includes("\\")) {
      fail(`Inline paths must use URL separators: ${path}`, path, "resolve");
    }

    let url: URL;
    try {
      url = new URL(path, entryURL);
    } catch (error) {
      fail(`Invalid inline path: ${path}`, path, "resolve", [], error);
    }

    if (!url.pathname.endsWith(".glts")) {
      fail(`Inline path must end in .glts: ${path}`, path, "resolve");
    }

    if (url.href === entryURL.href) {
      fail(`Inline path is reserved for the entry source: ${path}`, path, "resolve");
    }

    const existing = sources.get(url.href);
    if (existing) {
      fail(`Inline paths resolve to the same file: ${existing.path} and ${path}`, path, "resolve");
    }

    const absolute = /^[A-Za-z][A-Za-z\d+.-]*:/.test(path);
    const metaURL = absolute ? url.href : path;

    sources.set(url.href, { path, source, url, metaURL });
  }

  return sources;
}

function parseModule(source: string, path: string): ReturnType<typeof parse> {
  try {
    return parse(source, {
      plugins: ["decorators-legacy", "deferredImportEvaluation", "sourcePhaseImports", "typescript"],
      sourceFilename: path,
      sourceType: "module"
    });
  } catch (error) {
    fail("Unable to parse TypeScript source", path, "transform", [], error);
  }
}

function moduleSyntax(ast: ReturnType<typeof parse>, path: string): readonly Range[] {
  const importMetas = new Set<Node>();
  const metaURLs = new Map<Node, Range>();

  traverseFast(ast, (node) => {
    if (node.type === "ImportExpression") {
      fail("Dynamic imports are not supported", path, "transform");
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

    metaURLs.set(node.object, range(node, path));
  });

  for (const meta of importMetas) {
    if (!metaURLs.has(meta)) {
      fail("Only import.meta.url is supported", path, "transform");
    }
  }

  return [...metaURLs.values()];
}

function importType(node: ImportDeclaration, path: string): "type" | "value" {
  if (node.importKind === "typeof") {
    fail("Typeof imports are not supported", path, "transform");
  }

  return node.importKind === "type" ? "type" : "value";
}

function checkImport(node: ImportDeclaration, path: string): void {
  if (node.attributes && node.attributes.length > 0) {
    fail("Import attributes are not supported", path, "transform");
  }

  if (node.module || node.phase) {
    fail("Source-phase and deferred imports are not supported", path, "transform");
  }
}

function externalImports(node: ImportDeclaration, path: string): readonly ExternalImport[] {
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
      fail("Typeof imports are not supported", path, "transform");
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
    fail("Local GLTS imports must be default imports", path, "transform");
  }

  return {
    ...range(node, path),
    local: node.specifiers[0].local.name,
    url
  };
}

function resolveImport(
  specifier: string,
  importer: URL,
  path: string,
  sources: ReadonlyMap<string, Source>,
  root: boolean
): URL | undefined {
  if (isBare(specifier)) {
    return undefined;
  }

  let url: URL;
  try {
    url = new URL(specifier, importer);
  } catch (error) {
    fail(`Unable to resolve import: ${specifier}`, path, "resolve", [], error);
  }

  if (sources.has(url.href) || url.href === entryURL.href) {
    return url;
  }

  if (url.pathname.endsWith(".glts")) {
    fail(`Missing inline source for ${displayURL(url)}`, path, "resolve");
  }

  if (url.protocol === entryURL.protocol && url.host === entryURL.host) {
    if (root) {
      return undefined;
    }
    fail(`Local helper imports are not supported: ${specifier}`, path, "resolve");
  }

  return undefined;
}

function defaultClass(
  node: Extract<Node, { type: "ExportDefaultDeclaration" }>,
  path: string
): DefaultClass {
  if (node.declaration.type !== "ClassDeclaration") {
    fail("Inlined dependencies must default-export a class", path, "transform");
  }

  const exportRange = range(node, path);
  const classRange = range(node.declaration, path);
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

function readFile(
  source: string,
  url: URL,
  path: string,
  metaURL: string,
  sources: ReadonlyMap<string, Source>,
  root: boolean
): File {
  const ast = parseModule(source, path);
  const imports: LocalImport[] = [];
  const externals: ExternalImport[] = [];
  const importRanges: Range[] = [];
  let exported: DefaultClass | undefined;
  const firstNode = ast.program.body[0];
  let insertAt = firstNode ? range(firstNode, path).start : source.length;
  let bodyStarted = false;

  for (const node of ast.program.body) {
    if (node.type === "ImportDeclaration") {
      const nodeRange = range(node, path);
      importRanges.push(nodeRange);
      if (!bodyStarted) {
        insertAt = nodeRange.end;
      }

      const target = resolveImport(node.source.value, url, path, sources, root);
      if (!root || target) {
        checkImport(node, path);
      }
      if (target) {
        imports.push(localImport(node, target, path));
      } else {
        externals.push(...externalImports(node, path));
      }
      continue;
    }

    bodyStarted = true;
    if (!root && node.type === "TSImportEqualsDeclaration") {
      fail("TypeScript import-equals declarations are not supported", path, "transform");
    }

    if (root) {
      if (
        (node.type === "ExportNamedDeclaration" || node.type === "ExportAllDeclaration") &&
        node.source &&
        resolveImport(node.source.value, url, path, sources, root)
      ) {
        fail("Local GLTS re-exports are not supported", path, "transform");
      }
      continue;
    }

    if (node.type === "ExportDefaultDeclaration") {
      if (exported) {
        fail("Inlined dependency has more than one default export", path, "transform");
      }

      exported = defaultClass(node, path);
      continue;
    }

    if (
      node.type === "ExportNamedDeclaration" ||
      node.type === "ExportAllDeclaration" ||
      node.type === "TSExportAssignment" ||
      node.type === "TSNamespaceExportDeclaration"
    ) {
      fail("Inlined dependencies may only have a default export", path, "transform");
    }
  }

  if (!root && !exported) {
    fail("Inlined dependency must have a default export", path, "transform");
  }

  return {
    ...(exported ? { defaultClass: exported } : {}),
    externals,
    importRanges,
    imports,
    insertAt,
    metaURLs: root ? [] : moduleSyntax(ast, path),
    metaURL,
    path,
    source,
    url
  };
}

function sameImport(left: Extract<ExternalImport, { kind: "binding" }>, right: Extract<ExternalImport, { kind: "binding" }>): boolean {
  return (
    left.imported === right.imported &&
    left.source === right.source &&
    left.typeOnly === right.typeOnly
  );
}

function renderImport(value: ExternalImport): string {
  if (value.kind === "side-effect") {
    return `import ${JSON.stringify(value.source)};`;
  }

  const type = value.typeOnly ? " type" : "";
  if (value.imported === "default") {
    return `import${type} ${value.local} from ${JSON.stringify(value.source)};`;
  }

  if (value.imported === "*") {
    return `import${type} * as ${value.local} from ${JSON.stringify(value.source)};`;
  }

  const imported = /^[A-Za-z_$][A-Za-z\d_$]*$/.test(value.imported)
    ? value.imported
    : JSON.stringify(value.imported);
  const specifier = imported === value.local ? imported : `${imported} as ${value.local}`;
  return `import${type} { ${specifier} } from ${JSON.stringify(value.source)};`;
}

function collectImports(
  root: File,
  files: readonly File[],
  wrapperGroup: string
): string {
  const bindings = new Map<string, Extract<ExternalImport, { kind: "binding" }>>();
  const runtimeSources = new Set<string>();
  const added: ExternalImport[] = [];

  const collect = (value: ExternalImport, preserve: boolean): void => {
    if (value.kind === "side-effect") {
      if (runtimeSources.has(value.source)) {
        return;
      }

      runtimeSources.add(value.source);
      if (!preserve) {
        added.push(value);
      }
      return;
    }

    const existing = bindings.get(value.local);
    if (existing && !sameImport(existing, value)) {
      fail(
        `External import ${JSON.stringify(value.local)} conflicts with ${existing.path}`,
        value.path,
        "transform"
      );
    }

    if (existing) {
      return;
    }

    bindings.set(value.local, value);
    if (!value.typeOnly) {
      runtimeSources.add(value.source);
    }
    if (!preserve) {
      added.push(value);
    }
  };

  for (const value of root.externals) {
    collect(value, true);
  }
  for (const file of files) {
    for (const value of file.externals) {
      collect(value, false);
    }
  }
  collect({
    kind: "binding",
    imported: "Group",
    local: wrapperGroup,
    path: "<inline wrappers>",
    source: "three",
    typeOnly: false
  }, false);

  return added.map(renderImport).join("\n");
}

function indent(source: string): string {
  return source
    .split("\n")
    .map((line) => line.length > 0 ? `  ${line}` : line)
    .join("\n");
}

function sourceURL(metaURL: string): string {
  return `new URL(${JSON.stringify(metaURL)}, import.meta.url).href`;
}

function renderFile(
  file: File,
  name: string,
  names: ReadonlyMap<string, string>,
  wrapperGroup: string
): string {
  const exported = file.defaultClass;
  if (!exported) {
    fail("Inlined dependency has no default class", file.path, "transform");
  }

  const rewritten = new MagicString(file.source);
  for (const importRange of file.importRanges) {
    rewritten.remove(importRange.start, importRange.end);
  }
  for (const metaURL of file.metaURLs) {
    rewritten.overwrite(
      metaURL.start,
      metaURL.end,
      sourceURL(file.metaURL)
    );
  }

  let local: string;
  if (exported.kind === "named") {
    rewritten.remove(exported.exportStart, exported.classStart);
    local = exported.name;
  } else {
    local = `${name}_default`;
    rewritten.overwrite(exported.exportStart, exported.classStart, `const ${local} = `);
    rewritten.appendLeft(exported.classEnd, ";");
  }

  const aliases = file.imports.map((value) => {
    const target = names.get(value.url.href);
    if (!target) {
      fail(`Missing generated module for ${displayURL(value.url)}`, file.path, "transform");
    }
    return `const ${value.local} = ${target};`;
  });
  const body = rewritten.toString().trim();
  const wrapper = `return class extends ${wrapperGroup} {
  constructor() {
    super();
    this.name = ${sourceURL(file.metaURL)};
    this.add(new ${local}());
  }
};`;
  const content = [...aliases, body, wrapper].filter((part) => part.length > 0);
  return `const ${name} = (() => {\n${indent(content.join("\n\n"))}\n})();`;
}

function prefix(files: readonly File[]): string {
  const sources = files.map((file) => file.source);
  let value = "__glts_";
  while (sources.some((source) => source.includes(value))) {
    value += "_";
  }
  return value;
}

function validate(source: string): void {
  parseModule(source, "<inline output>");
}

/** Combines a root GLTS module and its in-memory dependencies into TypeScript ESM. */
export function inline(
  source: string,
  files: Readonly<Record<string, string>>
): string {
  const sources = sourceMap(files);
  const root = readFile(source, entryURL, "<entry>", entryURL.href, sources, true);
  if (root.imports.length === 0) {
    return source;
  }

  const loaded = new Map<string, File>();
  const ordered: File[] = [];

  const load = (url: URL, chain: readonly string[]): void => {
    if (loaded.has(url.href)) {
      return;
    }

    if (chain.includes(url.href)) {
      fail(
        "Cyclic GLTS imports are not supported",
        displayURL(url),
        "resolve",
        [...chain.map((value) => displayURL(new URL(value))), displayURL(url)]
      );
    }

    const input = sources.get(url.href);
    if (!input) {
      fail(`Missing inline source for ${displayURL(url)}`, displayURL(url), "resolve");
    }

    const file = readFile(
      input.source,
      input.url,
      input.path,
      input.metaURL,
      sources,
      false
    );
    const nextChain = [...chain, url.href];
    for (const dependency of file.imports) {
      load(dependency.url, nextChain);
    }

    loaded.set(url.href, file);
    ordered.push(file);
  };

  for (const dependency of root.imports) {
    load(dependency.url, [entryURL.href]);
  }

  const generatedPrefix = prefix([root, ...ordered]);
  const names = new Map<string, string>();
  ordered.forEach((file, index) => {
    names.set(file.url.href, `${generatedPrefix}${index}`);
  });
  const wrapperGroup = `${generatedPrefix}Group`;

  const imports = collectImports(root, ordered, wrapperGroup);
  const modules = ordered.map((file) => {
    const name = names.get(file.url.href);
    if (!name) {
      fail(`Missing generated name for ${file.path}`, file.path, "transform");
    }
    return renderFile(file, name, names, wrapperGroup);
  }).join("\n\n");
  const aliases = root.imports.map((value) => {
    const name = names.get(value.url.href);
    if (!name) {
      fail(`Missing generated module for ${displayURL(value.url)}`, "<entry>", "transform");
    }
    return `const ${value.local} = ${name};`;
  }).join("\n");
  const addition = [imports, modules, aliases].filter((part) => part.length > 0).join("\n\n");

  const rewritten = new MagicString(source);
  for (const value of root.imports) {
    rewritten.remove(value.start, value.end);
  }
  rewritten.appendLeft(root.insertAt, `\n\n${addition}`);

  const output = rewritten.toString();
  validate(output);
  return output;
}
