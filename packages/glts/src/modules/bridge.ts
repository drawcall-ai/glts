import * as THREE from "three";

import type { ScriptContext } from "../scene/execution.js";
import type { GLTSModules } from "../types.js";
import { moduleURL } from "./urls.js";

let bridgeSequence = 0;

function nextBridgeKey(): string {
  bridgeSequence += 1;
  return `__glts_bridge_${Date.now()}_${bridgeSequence}`;
}

/** Hands host values to generated modules through a global only they know the key of. */
export class ModuleBridge {
  /** Host namespaces by bare specifier, `three` included; generated host modules read them. */
  readonly namespaces: GLTSModules;
  readonly #hostModuleURLs = new Map<string, string>();
  readonly #contexts = new Map<number, ScriptContext>();
  readonly #bridgeKey = nextBridgeKey();
  /** Starts every generated module; a module evaluated after disposal fails. */
  readonly #prologue = [
    `const bridge = globalThis[${JSON.stringify(this.#bridgeKey)}];`,
    "if (!bridge) throw new Error('GLTS bridge is unavailable');"
  ];
  /** Stands in for `@drawcall/glts` in a linked script until an execution creates its context module. */
  readonly contextToken = `glts-context:${this.#bridgeKey}`;
  #contextSequence = 0;

  constructor(modules: GLTSModules) {
    this.namespaces = { ...modules, three: THREE };
    Reflect.set(globalThis, this.#bridgeKey, this);
    for (const [specifier, namespace] of Object.entries(this.namespaces)) {
      this.#hostModuleURLs.set(specifier, moduleURL(this.#hostModuleSource(specifier, namespace)));
    }
  }

  createContextModule(context: ScriptContext): {
    readonly release: () => void;
    readonly url: string;
  } {
    this.#contextSequence += 1;
    const id = this.#contextSequence;
    const url = moduleURL(
      [
        ...this.#prologue,
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
      release: () => this.#contexts.delete(id),
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

  takeContext(id: number): ScriptContext {
    const context = this.#contexts.get(id);
    if (!context) {
      throw new Error(`GLTS execution context is unavailable: ${id}`);
    }

    this.#contexts.delete(id);
    return context;
  }

  dispose(): void {
    Reflect.deleteProperty(globalThis, this.#bridgeKey);
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
