import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Canvas } from "@drawcall/webgpu";
import { withHeadless } from "../headless/index.js";
import type { GLTSScene } from "../types.js";

/**
 * Loads the script at `file` headlessly, encodes its scene with `encode`, and writes the bytes to `output`
 * atomically, printing its path.
 */
export async function writeHeadless(
  file: string,
  output: string,
  isPreview: boolean,
  size: number,
  encode: (scene: GLTSScene, canvas: Canvas) => Promise<Uint8Array>
): Promise<void> {
  const url = pathToFileURL(resolve(file));
  const bytes = await withHeadless({
    projectURL: url, baseURL: new URL(".", url), size,
    loader: { isPreview, resolve: (specifier) => specifier },
  }, async (loader, canvas) => encode(await loader.loadAsync(url), canvas));
  await write(output, bytes);
}

/** Writes `bytes` to `path` through a temporary file, so a failed write leaves no partial output, and prints the path. */
async function write(path: string, bytes: Uint8Array): Promise<void> {
  const output = resolve(path);
  await mkdir(dirname(output), { recursive: true });
  const temporary = `${output}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, bytes, { flag: "wx" });
    await rename(temporary, output);
  } finally {
    await rm(temporary, { force: true });
  }
  console.log(output);
}
