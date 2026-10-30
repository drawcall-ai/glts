import { REVISION } from "three";

import { GLTSError, type GLTSErrorDetails } from "../errors.js";
import { gltsSpecifier } from "../imports.js";
import { canonicalize } from "../urls.js";

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

/** The CDN path of a Three addon, in either spelling, pinned to the revision of the `three` it shares. */
function threeAddonPath(specifier: string): string | undefined {
  if (specifier.startsWith("three/addons/")) {
    return `three@0.${REVISION}.0/examples/jsm/${specifier.slice("three/addons/".length)}`;
  }
  if (specifier.startsWith("three/examples/")) return `three@0.${REVISION}.0/${specifier.slice("three/".length)}`;
  return undefined;
}

/** The CDN bundle of the bare `specifier`, importing the `shared` packages instead of inlining them. */
export function cdnPackageURL(specifier: string, cdnURL: URL, shared: readonly string[]): URL {
  const addon = threeAddonPath(specifier);
  // A package in its own external list comes back unbundled, one module per file; an addon must share `three`.
  const external = addon ? shared : shared.filter((name) => packageName(name) !== packageName(specifier));
  const url = new URL(addon ?? specifier, cdnURL);
  url.searchParams.set("bundle", "");
  url.searchParams.set("external", [...new Set(external)].sort().join(","));
  url.searchParams.set("target", "es2022");
  return url;
}

/**
 * What an import from the module at `importerURL` names: a package, by bare specifier, which the host may provide
 * and `cdnPackageURL` otherwise bundles, or the module at a URL. The loader and the bundler both resolve through
 * this, so provenance names the modules a bundle ships.
 */
export function resolveImport(specifier: string, importerURL: string, cdnURL: URL): { readonly package: string } | { readonly url: string } {
  if (isBareSpecifier(specifier)) return { package: specifier };
  const url = new URL(specifier, importerURL);
  const peer = specifier.startsWith("/") ? peerName(url, cdnURL) : undefined;
  return peer ? { package: peer } : { url: canonicalize(url) };
}

/**
 * The package a CDN bundle imports as a peer, which the CDN writes as an unbundled root path such as
 * `/pkg@^1.0.0?external=three`. Imported by name instead, it shares the host's or the CDN's instance.
 */
function peerName(url: URL, cdnURL: URL): string | undefined {
  if (url.origin !== cdnURL.origin || !url.pathname.startsWith(cdnURL.pathname) || url.searchParams.has("bundle")) return;
  return /^((?:@[^/]+\/)?[^/@]+)@[^/]+$/.exec(url.pathname.slice(cdnURL.pathname.length))?.[1];
}

/** What an import of a script or helper refers to. */
export type ScriptImport =
  /** `@drawcall/glts`. */
  | { readonly kind: "glts" }
  | { readonly kind: "helper"; readonly url: string }
  /** A bare specifier or an http(s) URL. */
  | { readonly kind: "package" };

/** Classifies an import of the script or helper at `importerURL`, throwing for one it cannot make. */
export function classifyImport(specifier: string, importerURL: string, chain: readonly string[]): ScriptImport {
  if (specifier === gltsSpecifier) return { kind: "glts" };
  const helper = helperURL(specifier, importerURL);
  if (helper) return { kind: "helper", url: canonicalize(helper) };
  assertScriptImport(specifier, importerURL, chain);
  return { kind: "package" };
}

/** The URL of a helper, a `./` or `../` import of a `.ts` file, or undefined for any other import. */
function helperURL(specifier: string, importerURL: string): URL | undefined {
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) return;
  const url = new URL(specifier, importerURL);
  return url.pathname.endsWith(".ts") ? url : undefined;
}

/** Throws for an import scripts and helpers cannot make; besides helpers, they import packages and http(s) URLs. */
function assertScriptImport(specifier: string, importerURL: string, chain: readonly string[]): void {
  if (isBareSpecifier(specifier)) return;

  const details: GLTSErrorDetails = { importChain: chain, phase: "resolve", url: importerURL };
  if (new URL(specifier, importerURL).pathname.endsWith(".glts")) {
    throw new GLTSError(`GLTS scripts cannot be imported: ${specifier}; use gltsLoader.loadAsync()`, details);
  }
  if (/^https?:/i.test(specifier)) return;
  throw new GLTSError(
    `Unsupported local import: ${specifier}; import helpers as ./*.ts files and load other files with import.meta.url`,
    details,
  );
}
