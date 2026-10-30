import * as Placeholders from "./placeholders.js";

/** The package scripts import their execution bindings from. */
export const gltsSpecifier = "@drawcall/glts";

/** The bare specifiers every loader provides scripts and helpers with, rather than resolving them. */
export const providedSpecifiers = ["three", "three/webgpu", "three/tsl", gltsSpecifier] as const;

export type ProvidedSpecifier = (typeof providedSpecifiers)[number];

/** The runtime bindings implement the script exports, whose declarations define their types. */
export type Bindings = Readonly<typeof Placeholders>;

/** The names a script imports from `@drawcall/glts`. */
export const importNames: ReadonlySet<string> = new Set(Object.keys(Placeholders));

/** The namespace a script's `@drawcall/glts` imports read, owned by its execution rather than an ESM module. */
export function importNamespace(bindings: Bindings): object {
  const namespace = {};
  Object.setPrototypeOf(namespace, null);
  // Preserve the scene getter, which follows the node adopted on reload.
  Object.defineProperties(namespace, Object.getOwnPropertyDescriptors(bindings));
  Object.defineProperty(namespace, Symbol.toStringTag, { value: "Module" });
  return Object.freeze(namespace);
}
