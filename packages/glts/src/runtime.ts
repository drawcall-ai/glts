import * as THREE from "three";

import type { ScriptContext } from "./execution.js";
import { GLTSError } from "./errors.js";
import { ModuleURLStore } from "./module-url-store.js";

let runtimeSequence = 0;

function nextRuntimeKey(): string {
  runtimeSequence += 1;
  return `__glts_runtime_${Date.now()}_${runtimeSequence}`;
}

export class ModuleRuntime {
  readonly #contexts = new Map<number, ScriptContext>();
  readonly #moduleURLs: ModuleURLStore;
  readonly #runtimeKey = nextRuntimeKey();
  #contextSequence = 0;
  #disposed = false;

  readonly threeModuleURL: string;

  constructor(moduleURLs: ModuleURLStore) {
    this.#moduleURLs = moduleURLs;
    Reflect.set(globalThis, this.#runtimeKey, this);
    this.threeModuleURL = moduleURLs.create(this.#threeBridgeSource());
  }

  contextModule(context: ScriptContext): {
    readonly release: () => void;
    readonly url: string;
  } {
    this.#assertActive();
    this.#contextSequence += 1;
    const id = this.#contextSequence;
    this.#contexts.set(id, context);

    const url = this.#moduleURLs.create([
      `const runtime = globalThis[${JSON.stringify(this.#runtimeKey)}];`,
      "if (!runtime) throw new Error('GLTS runtime is unavailable');",
      `const context = runtime.takeContext(${id});`,
      "let scene = context.scene;",
      "context.bindScene((next) => { scene = next; });",
      "const {",
      "  gltsLoader, instanceCount, loadingManager,",
      "  isPreview, onDispose, onFrame, onMatrixUpdateAt",
      "} = context;",
      "export {",
      "  gltsLoader, instanceCount, loadingManager,",
      "  isPreview, onDispose, onFrame, onMatrixUpdateAt, scene",
      "};"
    ].join("\n"));

    return {
      release: () => {
        this.#contexts.delete(id);
        this.#moduleURLs.release(url);
      },
      url
    };
  }

  getThreeExport(name: string): unknown {
    return Reflect.get(THREE, name);
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
    Reflect.deleteProperty(globalThis, this.#runtimeKey);
    this.#moduleURLs.dispose();
  }

  #threeBridgeSource(): string {
    const lines = [
      `const runtime = globalThis[${JSON.stringify(this.#runtimeKey)}];`,
      "if (!runtime) throw new Error('GLTS runtime is unavailable');"
    ];
    const exports: string[] = [];
    let index = 0;

    for (const name of Object.keys(THREE)) {
      if (!/^[$A-Z_a-z][$\w]*$/.test(name)) {
        continue;
      }

      const localName = `threeExport${index}`;
      lines.push(`const ${localName} = runtime.getThreeExport(${JSON.stringify(name)});`);
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
      url: "glts://runtime"
    });
  }
}
