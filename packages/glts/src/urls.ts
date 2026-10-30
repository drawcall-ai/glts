import { GLTSError } from "./errors.js";
import type { GLTSURL } from "./types.js";

export function canonicalize(url: URL): string {
  const canonical = new URL(url);
  canonical.hash = "";
  return canonical.href;
}

/** `url` canonicalized without its query, which varies per request of a script or helper. */
export function withoutQuery(url: string): string {
  const file = new URL(url);
  file.search = "";
  return canonicalize(file);
}

/** The URL the page resolves relative URLs against, or undefined outside a page. */
export function pageBase(): string | undefined {
  if (typeof document !== "undefined") return document.baseURI;
  if (typeof location !== "undefined") return location.href;
  return undefined;
}

/** Resolves `url` against the page's base URL; without a page, only an absolute `url` resolves. */
export function pageURL(url: GLTSURL): URL {
  const base = pageBase();
  if (base !== undefined) return new URL(url, base);
  if (URL.canParse(url)) return new URL(url);
  throw new GLTSError("A relative URL needs document.baseURI or location.href to resolve against", {
    phase: "resolve",
    url: String(url)
  });
}

/** Tells this copy of GLTS apart from others in the realm, which share one module map and one global object. */
const copy = Math.random().toString(36).slice(2);
let sequence = 0;

/** A name starting with `prefix` that no other call, of this or another copy of GLTS in the realm, returns. */
export function realmUnique(prefix: string): string {
  sequence += 1;
  return `${prefix}${copy}-${sequence}`;
}

/** The part of Node.js's `process` that identifies it, declared here so GLTS needs no Node.js types. */
declare const process: { versions?: { node?: string } } | undefined;

/** Whether this is Node.js, rather than a page or Web Worker, which a bundle's `process` shim may also define. */
export function isNode(): boolean {
  return typeof process !== "undefined" && process.versions?.node !== undefined;
}

/** Whether this runtime imports `blob:` URLs: pages and Web Workers do; Node.js creates them but cannot import them. */
export function importsBlobs(): boolean {
  return typeof URL.createObjectURL === "function" && !isNode();
}

/**
 * A `data:` URL that evaluates `source` as a module, for runtimes that cannot import `blob:` URLs, such as Node.js.
 * The fragment keeps every URL distinct, as engines evaluate one module per URL, and leaves the source untouched.
 */
export function moduleURL(source: string): string {
  return realmUnique(`data:text/javascript,${encodeURIComponent(source)}#`);
}
