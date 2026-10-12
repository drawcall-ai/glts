import * as THREE from "three";

import type { ScriptContext } from "../scene/execution.js";
import type { GLTSModules } from "../types.js";
import { ModuleURLStore } from "./urls.js";

let bridgeSequence = 0;

function nextBridgeKey(): string {
  bridgeSequence += 1;
  return `__glts_bridge_${Date.now()}_${bridgeSequence}`;
}

interface HostModule {
  readonly namespace: object;
  readonly url: string;
}

export class ModuleBridge {
  /** Every module URL of one loader, revoked with the bridge. */
  readonly moduleURLs = new ModuleURLStore();
  readonly #hostModules = new Map<string, HostModule>();
  readonly #contexts = new Map<number, ScriptContext>();
  readonly #bridgeKey = nextBridgeKey();
  /** Stands in for `@drawcall/glts` in a prepared script until an execution creates its context module. */
  readonly contextToken = `glts-context:${this.#bridgeKey}`;
  #contextSequence = 0;

  constructor(modules: GLTSModules = {}) {
    Reflect.set(globalThis, this.#bridgeKey, this);
    for (const [specifier, namespace] of Object.entries({ ...modules, three: THREE })) {
      this.#hostModules.set(specifier, { namespace, url: this.moduleURLs.create(this.#bridgeSource(specifier, namespace)) });
    }
  }

  createContextModule(context: ScriptContext): {
    readonly release: () => void;
    readonly url: string;
  } {
    this.#contextSequence += 1;
    const id = this.#contextSequence;
    const url = this.moduleURLs.create(
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
    this.#contexts.set(id, context);

    return {
      release: () => {
        this.#contexts.delete(id);
        this.moduleURLs.release(url);
      },
      url,
    };
  }

  /** The bare specifiers the host shares with scripts, `three` included. */
  get hostSpecifiers(): readonly string[] {
    return [...this.#hostModules.keys()];
  }

  getHostModuleURL(specifier: string): string | undefined {
    return this.#hostModules.get(specifier)?.url;
  }

  getModuleExport(specifier: string, name: string): unknown {
    const module = this.#hostModules.get(specifier);
    if (!module)
      throw new Error(`Shared module is unavailable: ${specifier}`);
    return Reflect.get(module.namespace, name);
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
    this.#contexts.clear();
    this.#hostModules.clear();
    Reflect.deleteProperty(globalThis, this.#bridgeKey);
    this.moduleURLs.dispose();
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
}
