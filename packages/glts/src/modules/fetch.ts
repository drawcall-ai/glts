import { GLTSError } from "../errors.js";

/** The part of Node.js's `process` that reads files, declared here so GLTS needs no Node.js types. */
declare const process: {
  getBuiltinModule(id: "node:fs/promises"): { readFile(url: URL, encoding: "utf8"): Promise<string> };
};

export type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface FetchedSource {
  readonly source: string;
  readonly url: string;
}

export function canonicalize(url: URL): string {
  const canonical = new URL(url);
  canonical.hash = "";
  return canonical.href;
}

/** Reads a `file:` URL from disk; `fetch` does not implement `file:`, and only Node.js can read it. */
function readFile(url: string): Promise<string> {
  if (typeof process === "undefined") {
    throw new Error("file: URLs can only be loaded in Node.js");
  }
  return process.getBuiltinModule("node:fs/promises").readFile(new URL(url), "utf8");
}

export async function fetchSource(
  fetch: Fetch,
  url: string,
  bypassCache: boolean,
  importChain: readonly string[]
): Promise<FetchedSource> {
  let response: Response;
  try {
    response = url.startsWith("file:")
      ? new Response(await readFile(url))
      : await fetch(url, { cache: bypassCache ? "no-cache" : "default" });
  } catch (error) {
    throw new GLTSError("Unable to fetch source", {
      importChain,
      phase: "fetch",
      url
    }, error);
  }

  if (!response.ok) {
    throw new GLTSError(`Request failed with ${response.status} ${response.statusText}`, {
      importChain,
      phase: "fetch",
      url
    });
  }

  try {
    return {
      source: await response.text(),
      url: canonicalize(new URL(response.url || url))
    };
  } catch (error) {
    throw new GLTSError("Unable to read response body", {
      importChain,
      phase: "fetch",
      url
    }, error);
  }
}
