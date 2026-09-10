import * as THREE from "three";

import { bindPhysics } from "./physics.js";
import type { ScriptContext } from "../scene/execution.js";
import { GLTSError } from "../errors.js";
import { ModuleURLStore } from "./urls.js";

let bridgeSequence = 0;

function nextBridgeKey(): string {
  bridgeSequence += 1;
  return `__glts_bridge_${Date.now()}_${bridgeSequence}`;
}

export class ModuleBridge {
  readonly #modules = new Map<string, object>([["three", THREE]]);
  readonly #bridges = new WeakMap<ScriptContext, string>();
  #physicsSequence = 0;
  readonly #contexts = new Map<number, ScriptContext>();
  readonly #moduleURLs: ModuleURLStore;
  readonly #bridgeKey = nextBridgeKey();
  #contextSequence = 0;
  #disposed = false;

  readonly threeModuleURL: string;

  constructor(moduleURLs: ModuleURLStore) {
    this.#moduleURLs = moduleURLs;
    Reflect.set(globalThis, this.#bridgeKey, this);
    this.threeModuleURL = moduleURLs.create(this.#bridgeSource("three", THREE));
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

  async getPhysicsModuleURL(context: ScriptContext): Promise<string> {
    this.#assertActive();
    const physics = await import("@drawcall/physics");
    const world = await context.physicsWorld();
    this.#assertActive();
    context.assertActive();
    const current = this.#bridges.get(context);
    if (current) return current;
    const namespace = bindPhysics(physics, context, world);
    const key = `physics:${++this.#physicsSequence}`;
    this.#modules.set(key, namespace);
    const url = this.#moduleURLs.create(this.#bridgeSource(key, namespace));
    this.#bridges.set(context, url);
    context.onDispose(() => {
      this.#modules.delete(key);
      this.#bridges.delete(context);
      this.#moduleURLs.release(url);
    });
    return url;
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
