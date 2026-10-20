import { getGLTSContext } from "./context.js";
import type { GLTSContext } from "./types.js";

/** The package scripts import their context from. */
export const gltsSpecifier = "@drawcall/glts";

/** The module compiled async functions import. */
export const runtimeSpecifier = "glts:runtime";

/** The bare specifiers every loader provides scripts and helpers with, rather than resolving them. */
export const providedSpecifiers = ["three", gltsSpecifier] as const;

export type ProvidedSpecifier = (typeof providedSpecifiers)[number];

const contextNames = [
  "scene", "gltsLoader", "instanceCount", "loadingManager", "isPreview", "onDispose", "onFrame", "onMatrixUpdateAt",
] as const satisfies readonly (keyof GLTSContext)[];

/** The contextual values a script imports from `@drawcall/glts`, each of which has a placeholder export. */
export type ContextName = (typeof contextNames)[number];

/** What a helper imports from `@drawcall/glts`: only getGLTSContext, as contextual values are the script's to pass. */
export const helperExports = { getGLTSContext };

/** The names a script imports from `@drawcall/glts`. */
export const importNames: ReadonlySet<string> = new Set([...contextNames, ...Object.keys(helperExports)]);

/** The namespace a script's `@drawcall/glts` imports read, owned by its execution rather than an ESM module. */
export function importNamespace(context: GLTSContext): object {
  const namespace = {};
  Object.setPrototypeOf(namespace, null);
  for (const name of contextNames) {
    // A getter, since a reload's execution adopts the node it replaces.
    Object.defineProperty(namespace, name, { enumerable: true, get: () => context[name] });
  }
  for (const [name, value] of Object.entries(helperExports)) {
    Object.defineProperty(namespace, name, { enumerable: true, value });
  }
  Object.defineProperty(namespace, Symbol.toStringTag, { value: "Module" });
  return Object.freeze(namespace);
}

/**
 * The `@drawcall/glts` CDN and npm packages import: the package's `namespace` with the host's `overrides`, which
 * extend it but never replace the context getter packages rely on.
 */
export function packageNamespace(namespace: object, overrides: object = {}): object {
  return { ...namespace, ...overrides, ...helperExports };
}
