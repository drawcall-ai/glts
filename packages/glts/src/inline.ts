import MagicString from "magic-string";

import {
  analyzeDependencyModule,
  analyzeEntryModule,
  failInline as fail,
  validateInlineSyntax,
  type DependencyModule,
  type EntryModule,
  type ExternalImport
} from "./inline-analysis.js";

const entryURL = new URL("glts://inline/entry.glts");

interface Source {
  readonly path: string;
  readonly source: string;
  readonly url: URL;
  readonly metaURL: string;
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
  root: EntryModule,
  files: readonly DependencyModule[],
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
  file: DependencyModule,
  name: string,
  names: ReadonlyMap<string, string>,
  wrapperGroup: string
): string {
  const exported = file.defaultClass;

  const rewritten = new MagicString(file.source);
  for (const removal of file.removals) {
    rewritten.remove(removal.start, removal.end);
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

function prefix(files: readonly { readonly source: string }[]): string {
  const sources = files.map((file) => file.source);
  let value = "__glts_";
  while (sources.some((source) => source.includes(value))) {
    value += "_";
  }
  return value;
}

/** Combines a root GLTS module and its in-memory dependencies into TypeScript ESM. */
export function inline(
  source: string,
  files: Readonly<Record<string, string>>
): string {
  const sources = sourceMap(files);
  const root = analyzeEntryModule({
    path: "<entry>",
    resolveImport: (specifier) =>
      resolveImport(specifier, entryURL, "<entry>", sources, true),
    source
  });
  if (root.imports.length === 0) {
    return source;
  }

  const loaded = new Map<string, DependencyModule>();
  const ordered: DependencyModule[] = [];

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

    const file = analyzeDependencyModule({
      metaURL: input.metaURL,
      path: input.path,
      resolveImport: (specifier) =>
        resolveImport(specifier, input.url, input.path, sources, false),
      source: input.source,
      url: input.url
    });
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
  validateInlineSyntax(output);
  return output;
}
