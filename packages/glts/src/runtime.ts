import * as THREE from "three";

import { GLTSError } from "./errors.js";
import { ModuleURLStore } from "./module-url-store.js";
import type { GLTSAssetClass } from "./types.js";

interface WrapperRecord {
  readonly url: string;
  raw: THREE.Object3D;
  disposed: boolean;
}

type WrapperClass = new () => THREE.Group;

interface StagedReplacement {
  readonly wrapper: THREE.Group;
  readonly record: WrapperRecord;
  readonly previous: THREE.Object3D;
  readonly next: THREE.Object3D;
}

let runtimeSequence = 0;

function nextRuntimeKey(): string {
  runtimeSequence += 1;
  return `__glts_runtime_${Date.now()}_${runtimeSequence}`;
}

function disposableMethod(value: object): unknown {
  return Reflect.get(value, "dispose");
}

function callDispose(value: object): void {
  const method = disposableMethod(value);
  if (typeof method !== "function") {
    return;
  }

  Reflect.apply(method, value, []);
}

export class WrapperRuntime {
  readonly #runtimeKey = nextRuntimeKey();
  readonly #moduleURLs: ModuleURLStore;
  readonly #assetClasses = new Map<string, GLTSAssetClass>();
  readonly #wrapperClasses = new Map<string, WrapperClass>();
  readonly #wrapperModuleURLs = new Map<string, string>();
  readonly #records = new WeakMap<THREE.Group, WrapperRecord>();
  readonly #liveWrappers = new Map<string, Set<THREE.Group>>();
  #constructionScope: Set<THREE.Group> | undefined;
  #disposed = false;

  readonly threeModuleURL: string;

  constructor(moduleURLs: ModuleURLStore) {
    this.#moduleURLs = moduleURLs;
    Reflect.set(globalThis, this.#runtimeKey, this);
    this.threeModuleURL = moduleURLs.create(this.#createThreeBridgeSource());
  }

  getThreeExport(name: string): unknown {
    return Reflect.get(THREE, name);
  }

  getWrapperConstructor(url: string): WrapperClass {
    const existing = this.#wrapperClasses.get(url);
    if (existing) {
      return existing;
    }

    const runtime = this;
    class GLTSWrapper extends THREE.Group {
      constructor() {
        super();
        this.name = url;
        runtime.#mountWrapper(this, url);
      }
    }

    this.#wrapperClasses.set(url, GLTSWrapper);
    return GLTSWrapper;
  }

  getWrapperModuleURL(url: string): string {
    const existing = this.#wrapperModuleURLs.get(url);
    if (existing) {
      return existing;
    }

    const source = [
      `const runtime = globalThis[${JSON.stringify(this.#runtimeKey)}];`,
      `if (!runtime) throw new Error(${JSON.stringify(`GLTS runtime is unavailable for ${url}`)});`,
      `const Wrapper = runtime.getWrapperConstructor(${JSON.stringify(url)});`,
      "export default Wrapper;"
    ].join("\n");
    const moduleURL = this.#moduleURLs.create(source);
    this.#wrapperModuleURLs.set(url, moduleURL);
    return moduleURL;
  }

  setAssetClass(url: string, assetClass: GLTSAssetClass): void {
    this.#assertActive();
    this.#assetClasses.set(url, assetClass);
  }

  createRoot(url: string): THREE.Group {
    this.#assertActive();
    return this.#withConstructionTransaction(() => {
      const Wrapper = this.getWrapperConstructor(url);
      return new Wrapper();
    });
  }

  replace(url: string, nextClass: GLTSAssetClass): void {
    this.#assertActive();
    const wrappers = [...(this.#liveWrappers.get(url) ?? [])];
    const staged: StagedReplacement[] = [];

    try {
      this.#withConstructionTransaction(() => {
        for (const wrapper of wrappers) {
          const record = this.#records.get(wrapper);
          if (!record || record.disposed) {
            continue;
          }

          staged.push({
            wrapper,
            record,
            previous: record.raw,
            next: this.#constructRaw(url, nextClass)
          });
        }
      });
    } catch (error) {
      const cleanupErrors = this.#disposeStaged(staged);
      if (cleanupErrors.length > 0) {
        throw new GLTSError(
          "Replacement construction and cleanup both failed",
          { url, phase: "reload" },
          new AggregateError([error, ...cleanupErrors])
        );
      }

      throw error;
    }

    this.#assetClasses.set(url, nextClass);

    for (const replacement of staged) {
      replacement.wrapper.remove(replacement.previous);
      replacement.wrapper.add(replacement.next);
      replacement.record.raw = replacement.next;
    }

    const disposalErrors: unknown[] = [];
    for (const replacement of staged) {
      try {
        this.#disposeRaw(replacement.previous);
      } catch (error) {
        disposalErrors.push(error);
      }
    }

    if (disposalErrors.length > 0) {
      throw new GLTSError(
        "Replacement committed, but one or more old instances failed to dispose",
        { url, phase: "dispose" },
        new AggregateError(disposalErrors)
      );
    }
  }

  disposeWrapper(wrapper: THREE.Group): void {
    const record = this.#records.get(wrapper);
    if (!record || record.disposed) {
      return;
    }

    record.disposed = true;
    wrapper.remove(record.raw);
    this.#removeLiveWrapper(wrapper, record.url);
    this.#records.delete(wrapper);
    this.#disposeRaw(record.raw);
  }

  dispose(): void {
    if (this.#disposed) {
      return;
    }

    const wrappers = [...this.#liveWrappers.values()].flatMap((group) => [...group]);
    const errors: unknown[] = [];

    for (const wrapper of wrappers) {
      try {
        this.disposeWrapper(wrapper);
      } catch (error) {
        errors.push(error);
      }
    }

    this.#disposed = true;
    Reflect.deleteProperty(globalThis, this.#runtimeKey);
    this.#moduleURLs.dispose();

    if (errors.length > 0) {
      throw new GLTSError(
        "One or more assets failed to dispose",
        { url: "glts://runtime", phase: "dispose" },
        new AggregateError(errors)
      );
    }
  }

  #mountWrapper(wrapper: THREE.Group, url: string): void {
    const mount = (): void => {
      const assetClass = this.#assetClasses.get(url);
      if (!assetClass) {
        throw new GLTSError("Asset has not been evaluated", {
          url,
          phase: "construct"
        });
      }

      const raw = this.#constructRaw(url, assetClass);
      const record: WrapperRecord = { url, raw, disposed: false };
      this.#records.set(wrapper, record);
      this.#addLiveWrapper(wrapper, url);
      this.#constructionScope?.add(wrapper);
      wrapper.add(raw);
    };

    if (this.#constructionScope) {
      mount();
      return;
    }

    this.#withConstructionTransaction(mount);
  }

  #constructRaw(url: string, assetClass: GLTSAssetClass): THREE.Object3D {
    let value: unknown;

    try {
      value = new assetClass();
    } catch (error) {
      throw new GLTSError("Default export failed during construction", {
        url,
        phase: "construct"
      }, error);
    }

    if (value instanceof THREE.Object3D) {
      return value;
    }

    if (typeof value === "object" && value !== null) {
      callDispose(value);
    }

    throw new GLTSError("Default export did not construct a THREE.Object3D", {
      url,
      phase: "construct"
    });
  }

  #withConstructionTransaction<T>(operation: () => T): T {
    if (this.#constructionScope) {
      return operation();
    }

    const scope = new Set<THREE.Group>();
    this.#constructionScope = scope;

    try {
      return operation();
    } catch (error) {
      const cleanupErrors = this.#rollbackConstruction(scope);
      if (cleanupErrors.length > 0) {
        throw new AggregateError([error, ...cleanupErrors], "GLTS construction rollback failed");
      }

      throw error;
    } finally {
      this.#constructionScope = undefined;
    }
  }

  #rollbackConstruction(scope: Set<THREE.Group>): unknown[] {
    const errors: unknown[] = [];
    const wrappers = [...scope].reverse();

    for (const wrapper of wrappers) {
      try {
        this.disposeWrapper(wrapper);
      } catch (error) {
        errors.push(error);
      }
    }

    return errors;
  }

  #disposeStaged(staged: readonly StagedReplacement[]): unknown[] {
    const errors: unknown[] = [];

    for (const replacement of staged) {
      try {
        this.#disposeRaw(replacement.next);
      } catch (error) {
        errors.push(error);
      }
    }

    return errors;
  }

  #disposeRaw(raw: THREE.Object3D): void {
    const nestedWrappers: THREE.Group[] = [];

    raw.traverse((object) => {
      if (object instanceof THREE.Group && this.#records.has(object)) {
        nestedWrappers.push(object);
      }
    });

    for (const wrapper of nestedWrappers) {
      this.disposeWrapper(wrapper);
    }

    callDispose(raw);
  }

  #addLiveWrapper(wrapper: THREE.Group, url: string): void {
    const wrappers = this.#liveWrappers.get(url) ?? new Set<THREE.Group>();
    wrappers.add(wrapper);
    this.#liveWrappers.set(url, wrappers);
  }

  #removeLiveWrapper(wrapper: THREE.Group, url: string): void {
    const wrappers = this.#liveWrappers.get(url);
    if (!wrappers) {
      return;
    }

    wrappers.delete(wrapper);
    if (wrappers.size === 0) {
      this.#liveWrappers.delete(url);
    }
  }

  #createThreeBridgeSource(): string {
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
      url: "glts://runtime",
      phase: "resolve"
    });
  }
}
