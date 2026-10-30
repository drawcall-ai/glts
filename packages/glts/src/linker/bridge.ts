import { toGLTSError } from "../errors.js";
import type { GLTSModules } from "../types.js";
import { importsBlobs, moduleURL, realmUnique } from "../urls.js";

/** Links a dynamic import of one linked module, recording it where that module's own imports are recorded. */
type LinkDynamic = (specifier: string) => Promise<string>;

interface DynamicImporter {
  /** The URL the importing module was fetched from, which import failures name. */
  readonly url: string;
  readonly link: LinkDynamic;
}

/** What a linked module throws once its loader is disposed. */
const disposedMessage = "The GLTS loader of this module has been disposed";

/** Hands host values to linked modules through a global only they know the key of. */
export class Bridge {
  /** Host namespaces by bare specifier or absolute helper URL; host modules read them. */
  readonly namespaces: GLTSModules;
  readonly #hostModuleURLs = new Map<string, string>();
  readonly #moduleURLs = new Set<string>();
  #disposed = false;
  /** The modules that use `import()`, by the index their stand-in passes; kept until disposal, like their module URLs. */
  readonly #importers: DynamicImporter[] = [];
  readonly #key = realmUnique("__glts_bridge_");

  constructor(namespaces: GLTSModules) {
    this.namespaces = namespaces;
    Reflect.set(globalThis, this.#key, this);
    for (const [specifier, namespace] of Object.entries(namespaces)) {
      this.#hostModuleURLs.set(specifier, this.module(this.#hostModuleSource(specifier, namespace)));
    }
  }

  /** The specifier and helper URL keys the host shares with scripts. */
  get hostSpecifiers(): readonly string[] {
    return [...this.#hostModuleURLs.keys()];
  }

  /**
   * The source of the function that stands in for the `import()` keyword in the module fetched from `url`, whose
   * dynamic imports `link` links when they run.
   */
  dynamicImportSource(url: string, link: LinkDynamic): string {
    const index = this.#importers.push({ url, link }) - 1;
    const bridge = `globalThis[${JSON.stringify(this.#key)}]`;
    return `(specifier) => ${bridge} ? ${bridge}.import(${index}, specifier)` +
      ` : Promise.reject(new Error(${JSON.stringify(disposedMessage)}))`;
  }

  async import(index: number, specifier: unknown): Promise<unknown> {
    const importer = this.#importers[index];
    if (!importer) throw new Error(`Unknown GLTS dynamic importer: ${index}`);
    let url: string;
    // Only linking fails as a resolve error; the imported module's own evaluation errors propagate unchanged.
    try {
      url = await importer.link(String(specifier));
    } catch (error) {
      throw toGLTSError(error, `Unable to import ${String(specifier)}`, { phase: "resolve", url: importer.url });
    }
    // Module URLs are resolved when loaded, never by a bundler.
    return import(/* @vite-ignore */ /* webpackIgnore: true */ url);
  }

  hostModuleURL(specifier: string): string | undefined {
    return this.#hostModuleURLs.get(specifier);
  }

  /** Short browser URLs avoid embedding imported source graphs again in every parent module. */
  module(source: string): string {
    if (this.#disposed) throw new Error(disposedMessage);
    if (!importsBlobs()) return moduleURL(source);
    const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
    this.#moduleURLs.add(url);
    return url;
  }

  dispose(): void {
    this.#disposed = true;
    Reflect.deleteProperty(globalThis, this.#key);
    // Retain old graphs until disposal: a failed reload can leave their scenes alive.
    for (const url of this.#moduleURLs) URL.revokeObjectURL(url);
    this.#moduleURLs.clear();
    this.#importers.length = 0;
  }

  #hostModuleSource(specifier: string, namespace: object): string {
    const names = Object.keys(namespace).filter((name) => /^[$A-Z_a-z][$\w]*$/.test(name));
    return [
      // A host module evaluated after disposal fails.
      `const bridge = globalThis[${JSON.stringify(this.#key)}];`,
      `if (!bridge) throw new Error(${JSON.stringify(disposedMessage)});`,
      `const namespace = bridge.namespaces[${JSON.stringify(specifier)}];`,
      ...names.map((name, index) => `const moduleExport${index} = namespace[${JSON.stringify(name)}];`),
      `export { ${names.map((name, index) => `moduleExport${index} as ${name}`).join(", ")} };`,
    ].join("\n");
  }
}
