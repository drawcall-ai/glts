import { registerHooks } from "node:module";
import { createCanvas, type Canvas as GPUCanvas } from "@drawcall/webgpu";
import { LoadingManager } from "three";
import { runAll } from "../errors.js";
import { withFiles } from "../files.js";
import { gltsSpecifier } from "../imports.js";
import { isBareSpecifier } from "../linker/resolution.js";
import { GLTSLoader } from "../loader/index.js";
import type { GLTSLoaderOptions } from "../types.js";
import { Canvas } from "./canvas.js";

interface HeadlessOptions {
  /** Native packages resolve from this file or project directory. */
  readonly projectURL: URL;
  /** Relative resources resolve against this page URL. */
  readonly baseURL: URL;
  readonly size: number;
  readonly loader: GLTSLoaderOptions;
  readonly resolveURL?: (url: string) => string;
}

// Fetch, document and native resolution hooks belong to the process, so sessions cannot overlap.
let active = false;

/** Supplies the same Node asset-loading environment to CLI rendering/export and build warmup. */
export async function withHeadless<T>(options: HeadlessOptions, use: (loader: GLTSLoader, canvas: GPUCanvas) => Promise<T>): Promise<T> {
  if (active) throw new Error("A headless GLTS session is already active");
  active = true;
  try { return await run(options, use); }
  finally { active = false; }
}

async function run<T>(options: HeadlessOptions, use: (loader: GLTSLoader, canvas: GPUCanvas) => Promise<T>): Promise<T> {
  const descriptors = ["fetch", "document"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  const cleanups: (() => void | Promise<void>)[] = [() => runAll("Headless globals restoration failed", descriptors.map(([key, descriptor]) => () => {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else if (!Reflect.deleteProperty(globalThis, key)) throw new Error(`Unable to restore headless global ${key}`);
  }))];
  const failures: unknown[] = [];
  try {
    const fetchFiles = withFiles(globalThis.fetch);
    Object.defineProperty(globalThis, "fetch", { configurable: true, writable: true, value: (input: RequestInfo | URL, init?: RequestInit) => {
      const href = input instanceof Request ? input.url : String(input);
      const url = new URL(options.resolveURL?.(href) ?? href, options.baseURL).href;
      return fetchFiles(url === href ? input : input instanceof Request ? new Request(url, input) : url, init);
    } });
    Object.defineProperty(globalThis, "document", { configurable: true, writable: true, value: {
      baseURI: options.baseURL.href,
      createElement(name: string) {
        if (name !== "canvas") throw new Error(`Headless GLTS does not support document.createElement(${JSON.stringify(name)})`);
        return new Canvas(1, 1);
      },
    } });
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
    });
    cleanups.push(() => hooks.deregister());
    const canvas = await createCanvas(options.size, options.size);
    cleanups.push(() => canvas.dispose());
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
