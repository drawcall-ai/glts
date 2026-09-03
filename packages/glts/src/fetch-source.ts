import { GLTSError } from "./errors.js";
import type { GLTSFetch } from "./types.js";

export interface FetchedSource {
  readonly source: string;
  readonly url: string;
}

export function canonicalize(url: URL): string {
  const canonical = new URL(url);
  canonical.hash = "";
  return canonical.href;
}

export async function fetchSource(
  fetch: GLTSFetch,
  url: string,
  bypassCache: boolean,
  importChain: readonly string[]
): Promise<FetchedSource> {
  let response: Response;
  try {
    response = await fetch(url, { cache: bypassCache ? "no-cache" : "default" });
  } catch (error) {
    throw new GLTSError("Network request failed", {
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
