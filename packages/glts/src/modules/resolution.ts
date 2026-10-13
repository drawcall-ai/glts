import { GLTSError, type GLTSErrorContext } from "../errors.js";

/** Where packages come from unless configured otherwise. */
export const defaultCDNURL = "https://esm.sh/";

export function isBareSpecifier(specifier: string): boolean {
  return !specifier.startsWith(".") && !specifier.startsWith("/") &&
    !/^[A-Za-z][A-Za-z\d+.-]*:/.test(specifier);
}

/** The package a bare specifier imports from, e.g. `@scope/x` for `@scope/x@1/sub`. */
export function packageName(specifier: string): string {
  const name = /^(?:@[^/]+\/)?[^/@]+/.exec(specifier)?.[0];
  if (!name) throw new Error(`Invalid package specifier: ${specifier}`);
  return name;
}

/** Whether a bare specifier pins a version, e.g. `simplex-noise@4`; those always come from the CDN. */
export function hasVersion(specifier: string): boolean {
  return specifier.startsWith(`${packageName(specifier)}@`);
}

/** The CDN bundle of a package, importing the `external` packages instead of inlining them. */
export function packageURL(path: string, cdnURL: URL, external: readonly string[]): URL {
  const url = new URL(path, cdnURL);
  url.searchParams.set("bundle", "");
  url.searchParams.set("external", external.join(","));
  url.searchParams.set("target", "es2022");
  return url;
}

/** The URL of a helper, a `./` or `../` import of a `.ts` file, or undefined for any other import. */
export function helperURL(specifier: string, importerURL: string): URL | undefined {
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) return;
  const url = new URL(specifier, importerURL);
  return url.pathname.endsWith(".ts") ? url : undefined;
}

/** Throws for an import scripts and helpers cannot make; besides helpers, they import packages and http(s) URLs. */
export function assertScriptImport(specifier: string, importerURL: string, importChain: readonly string[]): void {
  const context: GLTSErrorContext = { importChain, phase: "resolve", url: importerURL };
  if (specifier.startsWith("#")) {
    throw new GLTSError(`Unsupported package import: ${specifier}`, context);
  }
  if (isBareSpecifier(specifier)) return;

  if (new URL(specifier, importerURL).pathname.endsWith(".glts")) {
    throw new GLTSError(`Static GLTS imports are not supported: ${specifier}; use gltsLoader.loadAsync()`, context);
  }
  if (/^https?:/i.test(specifier)) return;
  throw new GLTSError(
    `Unsupported local import: ${specifier}; import helpers as ./*.ts files and load other files with import.meta.url`,
    context,
  );
}
