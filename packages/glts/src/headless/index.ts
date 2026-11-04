import { registerHooks } from "node:module";
import { createCanvas, type Canvas as GPUCanvas } from "@drawcall/webgpu";
import { LoadingManager } from "three";
import { withFiles } from "../files.js";
import { gltsSpecifier } from "../imports.js";
import { isBareSpecifier } from "../linker/resolution.js";
import { GLTSLoader } from "../loader/index.js";
import type { GLTSLoaderOptions } from "../types.js";
import { Canvas, copyableCanvases, readableBitmaps } from "./canvas.js";
import { setGlobals } from "./globals.js";
import { moduleWorkers } from "./workers.js";

interface HeadlessOptions {
  /** Native packages resolve from this file or project directory. */
  readonly projectURL: URL;
  /** Relative resources resolve against this page URL. */
  readonly baseURL: URL;
  readonly size: number;
  readonly loader: GLTSLoaderOptions;
  readonly resolveURL?: (url: string) => string;
}

// Globals and native resolution hooks belong to the process, so sessions cannot overlap.
let active = false;

/**
 * Supplies the same Node asset-loading environment to CLI rendering/export and build warmup: a WebGPU canvas, file
 * fetches, a document making 2D canvases, OffscreenCanvas, ImageBitmaps they draw, and module workers.
 */
export async function withHeadless<T>(options: HeadlessOptions, use: (loader: GLTSLoader, canvas: GPUCanvas) => Promise<T>): Promise<T> {
  if (active) throw new Error("A headless GLTS session is already active");
  active = true;
  try { return await run(options, use); }
  finally { active = false; }
}

async function run<T>(options: HeadlessOptions, use: (loader: GLTSLoader, canvas: GPUCanvas) => Promise<T>): Promise<T> {
  const cleanups: (() => void | Promise<void>)[] = [];
  const failures: unknown[] = [];
  try {
    const fetchFiles = withFiles(globalThis.fetch);
    cleanups.push(setGlobals({
      fetch: (input: RequestInfo | URL, init?: RequestInit) => {
        const href = input instanceof Request ? input.url : String(input);
        const url = new URL(options.resolveURL?.(href) ?? href, options.baseURL).href;
        return fetchFiles(url === href ? input : input instanceof Request ? new Request(url, input) : url, init);
      },
      document: {
        baseURI: options.baseURL.href,
        createElement,
        // Three creates its canvases in the XHTML namespace.
        createElementNS(namespace: string, name: string) {
          if (namespace !== "http://www.w3.org/1999/xhtml") throw new Error(`Headless GLTS does not support elements in ${namespace}`);
          return createElement(name);
        },
      },
      OffscreenCanvas: Canvas,
    }));
    const { env } = options.loader;
    const hooks = registerHooks({
      resolve(specifier, context, nextResolve) {
        if (specifier === "three" || specifier.startsWith("three/")) {
          return nextResolve(specifier, { ...context, parentURL: import.meta.url, conditions: ["node", "import"] });
        }
        if (specifier === gltsSpecifier) return nextResolve(new URL("../index.js", import.meta.url).href, context);
        if (context.parentURL?.startsWith("data:") && isBareSpecifier(specifier)) {
          return nextResolve(specifier, { ...context, parentURL: options.projectURL.href });
        }
        return nextResolve(specifier, context);
      },
      // Packages imported natively see the env scripts see, as Vite defines it for the app's packages in the browser.
      load(url, context, nextLoad) {
        const loaded = nextLoad(url, context);
        if (!env || (loaded.format !== "module" && loaded.format !== "module-typescript") || loaded.source == null) return loaded;
        const source = typeof loaded.source === "string" ? loaded.source : new TextDecoder().decode(loaded.source);
        if (!source.includes("import.meta.env")) return loaded;
        const prologue = `import.meta.env = ${JSON.stringify(env)};`;
        return { ...loaded, source: source.replace(/^(#!.*\n)?/, (hashbang) => hashbang + prologue) };
      },
    });
    cleanups.push(() => hooks.deregister());
    const canvas = await createCanvas(options.size, options.size);
    cleanups.push(() => canvas.dispose(), copyableCanvases());
    // The canvas installs createImageBitmap and a classic Worker, which these extend until it is disposed.
    const bitmaps = readableBitmaps(globalThis.createImageBitmap);
    const workers = moduleWorkers(Reflect.get(globalThis, "Worker"));
    cleanups.push(bitmaps.dispose, workers.dispose, setGlobals({ createImageBitmap: bitmaps.createImageBitmap, Worker: workers.Worker }));
    const manager = new LoadingManager();
    if (options.resolveURL) manager.setURLModifier(options.resolveURL);
    const loader = new GLTSLoader(manager, options.loader);
    cleanups.push(() => loader.dispose());
    return await use(loader, canvas);
  } catch (error) {
    failures.push(error);
    throw error;
  } finally {
    for (const cleanup of cleanups.reverse()) {
      try { await cleanup(); }
      catch (error) { failures.push(error); }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Headless GLTS operation and cleanup failed");
  }
}

function createElement(name: string): Canvas {
  if (name !== "canvas") throw new Error(`Headless GLTS does not support document.createElement(${JSON.stringify(name)})`);
  return new Canvas(1, 1);
}
