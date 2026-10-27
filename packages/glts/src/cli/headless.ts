import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createCanvas, type Canvas } from "@drawcall/webgpu";
import { LoadingManager } from "three/webgpu";
import { GLTSLoader } from "../loader/index.js";
import type { GLTSScene } from "../types.js";
import { withFiles } from "../files.js";
import { isBareSpecifier } from "../linker/resolution.js";
import { cleanUpAndThrow } from "../errors.js";

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
  const canvas = await createCanvas(size, size);
  let bytes: Uint8Array;
  try {
    bytes = await withHeadlessScene(file, isPreview, (scene) => encode(scene, canvas));
  } finally {
    await canvas.dispose();
  }
  await write(output, bytes);
}

/** Loads the script at `file` headlessly and returns what `use` makes of its scene, then disposes the loader. */
async function withHeadlessScene<T>(file: string, isPreview: boolean, use: (scene: GLTSScene) => Promise<T>): Promise<T> {
  const url = pathToFileURL(resolve(file));
  const fetch = globalThis.fetch;
  // Scripts load their resources, such as textures, with `fetch`.
  globalThis.fetch = withFiles(fetch);
  // Linked modules run as data URLs; native package imports belong to the script's project.
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      // Packages, including the packages they import, share the host's Three instance.
      if (specifier === "three" || specifier.startsWith("three/")) {
        return nextResolve(specifier, { ...context, parentURL: import.meta.url, conditions: ["node", "import"] });
      }
      if (context.parentURL?.startsWith("data:") && isBareSpecifier(specifier)) {
        return nextResolve(specifier, { ...context, parentURL: url.href });
      }
      return nextResolve(specifier, context);
    }
  });
  const loader = new GLTSLoader(new LoadingManager(), { isPreview, resolve: specifier => specifier });
  try {
    let result: T;
    try { result = await use(await loader.loadAsync(url)); }
    catch (error) { cleanUpAndThrow(error, url.href, () => loader.dispose()); }
    loader.dispose();
    return result;
  } finally {
    hooks.deregister();
    globalThis.fetch = fetch;
  }
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
