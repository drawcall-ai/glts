import { GLTSError } from "../errors.js";
import { canonicalize } from "../urls.js";

export type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** The source of a script, helper, or package and the URL it came from, after redirects. */
export interface Source {
  readonly source: string;
  readonly url: string;
}

export async function fetchSource(
  fetch: Fetch,
  url: string,
  bypassCache: boolean,
  chain: readonly string[]
): Promise<Source> {
  let response: Response;
  try {
    response = await fetch(url, { cache: bypassCache ? "no-cache" : "default" });
  } catch (error) {
    throw new GLTSError("Unable to fetch source", { importChain: chain, phase: "fetch", url }, error);
  }

  if (!response.ok) {
    throw new GLTSError(`Request failed with ${response.status} ${response.statusText}`, { importChain: chain, phase: "fetch", url });
  }

  try {
    return { source: await response.text(), url: canonicalize(new URL(response.url || url)) };
  } catch (error) {
    throw new GLTSError("Unable to read response body", { importChain: chain, phase: "fetch", url }, error);
  }
}
