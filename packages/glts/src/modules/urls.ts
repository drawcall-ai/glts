/** Tells this copy of GLTS apart from others in the realm, which share one module map. */
const copy = Math.random().toString(36).slice(2);
let sequence = 0;

/**
 * A `data:` URL that evaluates `source` as a module; unlike `blob:` URLs, browsers and Node.js both import it.
 * The fragment keeps every URL distinct, as engines evaluate one module per URL, and leaves the source untouched.
 */
export function moduleURL(source: string): string {
  sequence += 1;
  return `data:text/javascript,${encodeURIComponent(source)}#${copy}-${sequence}`;
}
