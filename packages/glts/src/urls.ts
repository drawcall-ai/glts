import { GLTSError } from "./errors.js";
import type { GLTSURL } from "./types.js";

export function canonicalize(url: URL): string {
  const canonical = new URL(url);
  canonical.hash = "";
  return canonical.href;
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

/**
 * A `data:` URL that evaluates `source` as a module; unlike `blob:` URLs, browsers and Node.js both import it.
 * The fragment keeps every URL distinct, as engines evaluate one module per URL, and leaves the source untouched.
 */
export function moduleURL(source: string): string {
  return realmUnique(`data:text/javascript,${encodeURIComponent(source)}#`);
}
