import { toGLTSError } from "../errors.js";
import { bindGenerator, currentExecution } from "../context.js";
import type { Dependencies } from "../dependencies.js";
import { helperExports } from "../imports.js";
import type { GLTSModules } from "../types.js";
import { moduleURL, realmUnique } from "../urls.js";
import type { Importer } from "./index.js";

type LinkDynamic = (importer: Importer, specifier: string, running: Dependencies | undefined) => Promise<string>;

/** What a linked module throws once its loader is disposed. */
const disposedMessage = "The GLTS loader of this module has been disposed";

/** Hands host values to linked modules through a global only they know the key of. */
export class Bridge {
  /** Host namespaces by bare specifier; host modules read them. */
  readonly namespaces: GLTSModules;
  readonly #hostModuleURLs = new Map<string, string>();
  /** Links a dynamic import of a linked module as it runs, adding it to the running execution's dependencies. */
  readonly #linkDynamic: LinkDynamic;
  readonly #key = realmUnique("__glts_bridge_");
  /** Starts every linked module; a module evaluated after disposal fails. */
  readonly #prologue = [
    `const bridge = globalThis[${JSON.stringify(this.#key)}];`,
    `if (!bridge) throw new Error(${JSON.stringify(disposedMessage)});`,
  ];
  /** The `glts:runtime` module compiled async functions import. */
  readonly runtimeURL = moduleURL([...this.#prologue, "export const { bindGenerator } = bridge;"].join("\n"));
  /** A helper's `@drawcall/glts`. */
  readonly helperGLTSURL = moduleURL([
    ...this.#prologue,
    `export const { ${Object.keys(helperExports).join(", ")} } = bridge.helperExports;`,
  ].join("\n"));
  readonly bindGenerator = bindGenerator;
  readonly helperExports = helperExports;

  constructor(namespaces: GLTSModules, linkDynamic: LinkDynamic) {
    this.namespaces = namespaces;
    this.#linkDynamic = linkDynamic;
    Reflect.set(globalThis, this.#key, this);
    for (const [specifier, namespace] of Object.entries(namespaces)) {
      this.#hostModuleURLs.set(specifier, moduleURL(this.#hostModuleSource(specifier, namespace)));
    }
  }

  /** The bare specifiers the host shares with scripts. */
  get hostSpecifiers(): readonly string[] {
    return [...this.#hostModuleURLs.keys()];
  }

  /** The source of the function that stands in for the `import()` keyword in the linked module of `importer`. */
  dynamicImportSource(importer: Importer): string {
    const bridge = `globalThis[${JSON.stringify(this.#key)}]`;
    return `(specifier) => ${bridge} ? ${bridge}.import(${JSON.stringify(importer)}, specifier)` +
      ` : Promise.reject(new Error(${JSON.stringify(disposedMessage)}))`;
  }

  async import(importer: Importer, specifier: unknown): Promise<unknown> {
    // Read before any await, while the importing code's execution is still the running one.
    const running = currentExecution()?.dependencies;
    let url: string;
    // Outside the import, as Vite wraps it in a function that is not async.
    try {
      url = await this.#linkDynamic(importer, String(specifier), running);
    } catch (error) {
      throw toGLTSError(error, `Unable to import ${String(specifier)}`, { phase: "resolve", url: importer.url });
    }
    // Module URLs are resolved when loaded, never by a bundler.
    return import(/* @vite-ignore */ /* webpackIgnore: true */ url);
  }

  hostModuleURL(specifier: string): string | undefined {
    return this.#hostModuleURLs.get(specifier);
  }

  dispose(): void {
    Reflect.deleteProperty(globalThis, this.#key);
  }

  #hostModuleSource(specifier: string, namespace: object): string {
    const names = Object.keys(namespace).filter((name) => /^[$A-Z_a-z][$\w]*$/.test(name));
    return [
      ...this.#prologue,
      `const namespace = bridge.namespaces[${JSON.stringify(specifier)}];`,
      ...names.map((name, index) => `const moduleExport${index} = namespace[${JSON.stringify(name)}];`),
      `export { ${names.map((name, index) => `moduleExport${index} as ${name}`).join(", ")} };`,
    ].join("\n");
  }
}
