import * as THREE from "three";

import type { ScriptContext } from "../scene/execution.js";
import { GLTSError } from "../errors.js";
import type { GLTSModules } from "../types.js";
import { ModuleURLStore } from "./urls.js";

let bridgeSequence = 0;

function nextBridgeKey(): string {
  bridgeSequence += 1;
  return `__glts_bridge_${Date.now()}_${bridgeSequence}`;
}

export class ModuleBridge {
  readonly #modules = new Map<string, object>();
  readonly #hostModuleURLs = new Map<string, string>();
  readonly #contexts = new Map<number, ScriptContext>();
  readonly #moduleURLs: ModuleURLStore;
  readonly #bridgeKey = nextBridgeKey();
  #contextSequence = 0;
  #disposed = false;

  constructor(moduleURLs: ModuleURLStore, modules: GLTSModules = {}) {
    this.#moduleURLs = moduleURLs;
    Reflect.set(globalThis, this.#bridgeKey, this);
    for (const [specifier, namespace] of Object.entries({ ...modules, three: THREE })) {
      this.#modules.set(specifier, namespace);
      this.#hostModuleURLs.set(specifier, moduleURLs.create(this.#bridgeSource(specifier, namespace)));
    }
  }

  createContextModule(context: ScriptContext): {
    readonly release: () => void;
    readonly url: string;
  } {
    this.#assertActive();
    this.#contextSequence += 1;
    const id = this.#contextSequence;
    this.#contexts.set(id, context);

    const url = this.#moduleURLs.create(
      [
        `const bridge = globalThis[${JSON.stringify(this.#bridgeKey)}];`,
        "if (!bridge) throw new Error('GLTS bridge is unavailable');",
        `const context = bridge.takeContext(${id});`,
        "let scene = context.scene;",
        "context.bindScene((next) => { scene = next; });",
        "const {",
        "  gltsLoader, instanceCount, loadingManager,",
        "  isPreview, onDispose, onFrame, onMatrixUpdateAt",
        "} = context;",
        "export {",
        "  gltsLoader, instanceCount, loadingManager,",
        "  isPreview, onDispose, onFrame, onMatrixUpdateAt, scene",
        "};",
      ].join("\n"),
    );

    return {
      release: () => {
        this.#contexts.delete(id);
        this.#moduleURLs.release(url);
      },
      url,
    };
  }

  /** The bare specifiers the host shares with scripts, `three` included. */
  get hostSpecifiers(): readonly string[] {
    return [...this.#hostModuleURLs.keys()];
  }

  getHostModuleURL(specifier: string): string | undefined {
    return this.#hostModuleURLs.get(specifier);
  }

  getModuleExport(specifier: string, name: string): unknown {
    const namespace = this.#modules.get(specifier);
    if (!namespace)
      throw new Error(`Shared module is unavailable: ${specifier}`);
    return Reflect.get(namespace, name);
  }

  takeContext(id: number): ScriptContext {
    const context = this.#contexts.get(id);
    if (!context) {
      throw new Error(`GLTS execution context is unavailable: ${id}`);
    }

    this.#contexts.delete(id);
    return context;
  }

  dispose(): void {
    if (this.#disposed) {
      return;
    }

    this.#disposed = true;
    this.#contexts.clear();
    this.#modules.clear();
    this.#hostModuleURLs.clear();
    Reflect.deleteProperty(globalThis, this.#bridgeKey);
    this.#moduleURLs.dispose();
  }

  #bridgeSource(specifier: string, namespace: object): string {
    const lines = [
      `const bridge = globalThis[${JSON.stringify(this.#bridgeKey)}];`,
      "if (!bridge) throw new Error('GLTS bridge is unavailable');",
    ];
    const exports: string[] = [];
    let index = 0;

    for (const name of Object.keys(namespace)) {
      if (!/^[$A-Z_a-z][$\w]*$/.test(name)) {
        continue;
      }

      const localName = `moduleExport${index}`;
      lines.push(
        `const ${localName} = bridge.getModuleExport(${JSON.stringify(specifier)}, ${JSON.stringify(name)});`,
      );
      exports.push(`${localName} as ${name}`);
      index += 1;
    }

    lines.push(`export { ${exports.join(", ")} };`);
    return lines.join("\n");
  }

  #assertActive(): void {
    if (!this.#disposed) {
      return;
    }

    throw new GLTSError("Loader has been disposed", {
      phase: "resolve",
      url: "glts://bridge",
    });
  }
}
