import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseEnv } from "node:util";
import type { Canvas } from "@drawcall/webgpu";
import { servedFiles, withHeadless } from "../headless/index.js";
import type { GLTSLoader } from "../loader/index.js";

export interface HeadlessScript {
  /** The script's path, relative to the working directory. */
  readonly file: string;
  /** The app's root directory. */
  readonly root: string;
  readonly isPreview: boolean;
  readonly size: number;
}

/**
 * Runs `encode` with a headless loader of the script and its URL, as the Vite dev server serves it to a page of the app
 * at `root`, and returns the bytes it encodes. The page's root is the app's `public` directory, or `root` without one,
 * and scripts see the `import.meta.env` Vite's development server gives the modules it runs in Node, so that caches
 * they fill match the app's.
 */
export async function runHeadless(
  { file, root, isPreview, size }: HeadlessScript,
  encode: (loader: GLTSLoader, url: URL, canvas: Canvas) => Promise<Uint8Array>
): Promise<Uint8Array> {
  const url = pathToFileURL(resolve(file));
  const publicDir = resolve(root, "public");
  const pageURL = pathToFileURL(`${existsSync(publicDir) ? publicDir : resolve(root)}/`);
  return await withHeadless({
    projectURL: url, baseURL: pageURL, size,
    resolveURL: servedFiles(pageURL, "/"),
    loader: { isPreview, env: await developmentEnv(root), resolve: (specifier) => specifier },
  }, (loader, canvas) => encode(loader, url, canvas));
}

/**
 * The `import.meta.env` Vite gives the development server's modules for an app at `root` served at `/`, as when it
 * renders them in Node rather than a page: its `VITE_` variables from `.env` files, overridden by the process
 * environment. Unlike Vite, values do not expand other variables, and `vite.config` is not read. Vite's own `loadEnv`
 * is not used, since Vite is an optional peer the CLI must run without.
 */
async function developmentEnv(root: string): Promise<Record<string, string | boolean>> {
  const variables: Record<string, string | undefined> = {};
  // The `.env` files Vite reads in development, each overriding those before it.
  for (const file of [".env", ".env.local", ".env.development", ".env.development.local"]) {
    const path = resolve(root, file);
    if (existsSync(path)) Object.assign(variables, parseEnv(await readFile(path, "utf8")));
  }
  Object.assign(variables, process.env);
  const vite = Object.entries(variables).flatMap(([key, value]) => key.startsWith("VITE_") && value !== undefined ? [[key, value]] : []);
  return { ...Object.fromEntries(vite), BASE_URL: "/", MODE: "development", DEV: true, PROD: false, SSR: true };
}

/** Writes `bytes` to `path` through a temporary file, so a failed write leaves no partial output, and prints the path. */
export async function write(path: string, bytes: Uint8Array): Promise<void> {
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
