/** The part of Node.js's `process` that reads files, declared here so GLTS needs no Node.js types. */
declare const process: {
  getBuiltinModule(id: "node:fs/promises"): { readFile(url: URL): Promise<Uint8Array<ArrayBuffer>> };
};

/** Reads a `file:` URL from disk like `fetch` reads http(s) ones; `fetch` does not implement `file:`, and only Node.js can read it. */
export async function fetchFile(url: string): Promise<Response> {
  if (typeof process === "undefined") throw new Error("file: URLs can only be loaded in Node.js");
  try {
    return new Response(await process.getBuiltinModule("node:fs/promises").readFile(new URL(url)));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return new Response(null, { status: 404, statusText: "File not found" });
    }
    throw error;
  }
}

/** `fetch`, reading `file:` URLs with fetchFile. */
export function withFiles(fetch: typeof globalThis.fetch): typeof globalThis.fetch {
  return (input, init) => {
    const href = input instanceof Request ? input.url : String(input);
    return href.startsWith("file:") ? fetchFile(href) : fetch(input, init);
  };
}
