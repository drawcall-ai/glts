import { GLTSError, type GLTSErrorContext } from "../errors.js";

export interface ResolutionOptions {
  readonly cdnURL: URL;
  readonly threeRevision: string;
  /** Packages the host shares; CDN bundles import them instead of inlining copies. */
  readonly hostSpecifiers: readonly string[];
}

export type ImportSource = "script" | "module";

export function isBareSpecifier(specifier: string): boolean {
  return !specifier.startsWith(".") && !specifier.startsWith("/") &&
    !/^[A-Za-z][A-Za-z\d+.-]*:/.test(specifier);
}

/** The CDN bundle of a package, importing the `external` packages instead of inlining them. */
export function packageURL(path: string, cdnURL: URL, external: readonly string[]): URL {
  const url = new URL(path, cdnURL);
  const separator = url.search ? "&" : "?";
  return new URL(`${url.href}${separator}bundle&external=${external.join(",")}&target=es2022`);
}

function packagePath(specifier: string, threeRevision: string): string {
  if (specifier.startsWith("three/addons/")) {
    return `three@0.${threeRevision}.0/examples/jsm/${specifier.slice("three/addons/".length)}`;
  }
  if (specifier.startsWith("three/examples/")) {
    return `three@0.${threeRevision}.0/${specifier.slice("three/".length)}`;
  }
  return specifier;
}

function shouldTransform(url: URL): boolean {
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const lastSegment = url.pathname.split("/").at(-1) ?? "";
  return !lastSegment.includes(".") || /\.(?:cjs|js|mjs)$/.test(lastSegment);
}

export function resolveModuleURL(
  specifier: string,
  importerURL: string,
  importChain: readonly string[],
  options: ResolutionOptions,
  source: ImportSource,
): { readonly url: URL; readonly transform: boolean } {
  const context: GLTSErrorContext = { importChain, phase: "resolve", url: importerURL };
  if (specifier.startsWith("#")) {
    const prefix = source === "script" ? "" : "CDN ";
    throw new GLTSError(`Unsupported ${prefix}package import: ${specifier}`, context);
  }
  if (isBareSpecifier(specifier)) {
    const path = packagePath(specifier, options.threeRevision);
    return { url: packageURL(path, options.cdnURL, options.hostSpecifiers), transform: true };
  }

  const url = new URL(specifier, importerURL);
  if (source === "module") return { url, transform: shouldTransform(url) };
  if (url.pathname.endsWith(".glts")) {
    throw new GLTSError(
      `Static GLTS imports are not supported: ${specifier}; use gltsLoader.loadAsync()`,
      context,
    );
  }
  if (
    (url.protocol === "http:" || url.protocol === "https:") &&
    !specifier.startsWith(".") && !specifier.startsWith("/")
  ) {
    return { url, transform: true };
  }
  throw new GLTSError(`Unsupported local import: ${specifier}`, context);
}
