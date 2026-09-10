import { GLTSError, type GLTSErrorContext } from "../errors.js";

export interface ResolutionOptions {
  readonly cdnURL: URL;
  readonly threeRevision: string;
}

export type ImportSource = "script" | "module";

function isBareSpecifier(specifier: string): boolean {
  return !specifier.startsWith(".") && !specifier.startsWith("/") &&
    !/^[A-Za-z][A-Za-z\d+.-]*:/.test(specifier);
}

function packageURL(specifier: string, options: ResolutionOptions): URL {
  const path = specifier.startsWith("three/addons/")
    ? `three@0.${options.threeRevision}.0/examples/jsm/${specifier.slice("three/addons/".length)}`
    : specifier.startsWith("three/examples/")
      ? `three@0.${options.threeRevision}.0/${specifier.slice("three/".length)}`
      : specifier;
  const url = new URL(path, options.cdnURL);
  const separator = url.search ? "&" : "?";
  return new URL(`${url.href}${separator}bundle&external=three,@drawcall/physics&target=es2022`);
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
    return { url: packageURL(specifier, options), transform: true };
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
