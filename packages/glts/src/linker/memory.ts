import { isNode, realmUnique } from "../urls.js";

/** The part of Node.js's `process` memory modules use, declared here so GLTS needs no Node.js types. */
declare const process: {
  getBuiltinModule(id: "node:module"): { registerHooks(hooks: ModuleHooks): { deregister(): void } };
} | undefined;

interface ModuleHooks {
  resolve(specifier: string, context: object, next: (specifier: string, context: object) => object): object;
  load(url: string, context: object, next: (url: string, context: object) => object): object;
}

/** Module sources by URL, which the hooks `memoryModuleURL` registers serve to Node.js's `import()`. */
const memorySources = new Map<string, string>();
/** The hooks, registered while memory sources exist. */
let hooks: { deregister(): void } | undefined;

/**
 * A URL Node.js imports `source` from until it is revoked. Node.js imports no `blob:` URLs, and a `data:` URL holding
 * the source would embed every dependency's encoded source again in each importer, so its module hooks serve the
 * source from memory. The URL is still a `data:` one, so that tools running modules in Node.js, such as Vite's module
 * runner, leave it to Node.js; imported first once revoked, it is that `data:` module, which throws.
 */
export function memoryModuleURL(source: string): string {
  if (typeof process === "undefined" || !isNode()) throw new Error("Memory module URLs are only available in Node.js");
  // The headless session's hooks (headless/index.ts) resolve the bare imports of modules with a `data:` URL against the
  // project, so these URLs stay `data:`; these hooks serve memory URLs before or after those, whichever registered last.
  hooks ??= process.getBuiltinModule("node:module").registerHooks({
    resolve: (specifier, context, next) => memorySources.has(specifier) ? { url: specifier, shortCircuit: true } : next(specifier, context),
    load: (url, context, next) => {
      const loaded = memorySources.get(url);
      return loaded === undefined ? next(url, context) : { format: "module", source: loaded, shortCircuit: true };
    },
  });
  const url = realmUnique(`data:text/javascript,${encodeURIComponent('throw new Error("This GLTS module was revoked")')}#`);
  memorySources.set(url, source);
  return url;
}

/** Releases a URL `memoryModuleURL` made, ignoring any other URL as `URL.revokeObjectURL` does, and the hooks with the last one. */
export function revokeMemoryModuleURL(url: string): void {
  if (!memorySources.delete(url) || memorySources.size > 0) return;
  hooks?.deregister();
  hooks = undefined;
}
