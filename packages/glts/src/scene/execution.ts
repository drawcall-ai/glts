import type { PhysicsWorld, RigidBody, Joint } from "@drawcall/physics";
import type * as THREE from "three";

import type {
  GLTSDisposeCallback,
  GLTSFrameCallback,
  GLTSScene,
  GLTSMatrixUpdateCallback,
  GLTSScriptLoader,
} from "../types.js";
import { createScriptScene, type GLTSScriptScene } from "./state.js";
import { NestedLoads } from "./nested.js";

export interface ScriptContext {
  readonly declarePhysics: () => void;
  readonly physicsWorld: () => Promise<PhysicsWorld>;
  readonly ownPhysics: (object: RigidBody | Joint) => void;
  readonly assertActive: () => void;
  readonly gltsLoader: GLTSScriptLoader;
  readonly instanceCount: number;
  readonly loadingManager: THREE.LoadingManager;
  readonly onDispose: (callback: GLTSDisposeCallback) => void;
  readonly onFrame: (callback: GLTSFrameCallback) => void;
  readonly onMatrixUpdateAt: (callback: GLTSMatrixUpdateCallback) => void;
  readonly isPreview: boolean;
  readonly scene: GLTSScriptScene;
  readonly bindScene: (bind: (scene: GLTSScene) => void) => void;
}

function assertCallback(value: unknown, name: string): void {
  if (typeof value !== "function") {
    throw new TypeError(`${name} expects a function`);
  }
}

export class Execution {
  readonly scene = createScriptScene();
  readonly nested: NestedLoads;
  readonly #disposals: GLTSDisposeCallback[] = [];
  readonly #frames: GLTSFrameCallback[] = [];
  readonly #matrixUpdates: GLTSMatrixUpdateCallback[] = [];
  readonly #matrices: readonly THREE.Matrix4[];
  #physics = false;
  #world: Promise<PhysicsWorld> | undefined;
  readonly #worldSource: (() => Promise<PhysicsWorld>) | undefined;
  readonly #physicsObjects = new Set<RigidBody | Joint>();
  #disposed = false;
  #committed = false;
  #bindScene: ((scene: GLTSScene) => void) | undefined;

  constructor(
    matrices: readonly THREE.Matrix4[],
    urls: readonly string[],
    parent?: Execution,
    worldSource?: () => Promise<PhysicsWorld>,
  ) {
    this.#matrices = matrices;
    this.#worldSource =
      worldSource ?? (parent ? () => parent.physicsWorld() : undefined);
    this.nested = new NestedLoads(urls, parent?.nested);
  }

  physicsWorld(): Promise<PhysicsWorld> {
    this.#world ??= this.#worldSource
      ? this.#worldSource()
      : import("@drawcall/physics").then((physics) =>
          physics.getDefaultWorld(),
        );
    return this.#world;
  }

  get physics(): boolean {
    return (
      !this.#disposed &&
      (this.#physics ||
        this.nested.nodes.some((node) => node.capabilities.physics))
    );
  }

  get committed(): boolean {
    return this.#committed;
  }

  commit(): void {
    this.#assertActive();
    if (this.#committed) return;
    for (const object of this.#physicsObjects) {
      const options = object.options;
      if ("body1" in options && (options.body0?.disposed || options.body1.disposed))
        object.dispose();
      if (!object.disposed) object.world.register(object);
    }
    this.#committed = true;
  }

  get animated(): boolean {
    return this.#frames.length > 0;
  }

  get nativeInstances(): boolean {
    return this.#matrixUpdates.length > 0;
  }

  context(options: {
    readonly gltsLoader: GLTSScriptLoader;
    readonly loadingManager: THREE.LoadingManager;
    readonly isPreview: boolean;
  }): ScriptContext {
    return {
      declarePhysics: () => {
        this.#physics = true;
      },
      physicsWorld: () => this.physicsWorld(),
      assertActive: () => this.#assertActive(),
      ownPhysics: (object) => {
        if (this.#disposed) {
          object.dispose();
          throw new Error("GLTS execution has been disposed");
        }
        this.#physicsObjects.add(object);
        if (!this.#committed) object.world.unregister(object);
      },
      bindScene: (bind) => {
        assertCallback(bind, "Internal scene binding");
        this.#bindScene = bind;
      },
      gltsLoader: options.gltsLoader,
      instanceCount: this.#matrices.length,
      loadingManager: options.loadingManager,
      onDispose: (callback) => {
        this.#assertActive();
        assertCallback(callback, "onDispose");
        this.#disposals.push(callback);
      },
      onFrame: (callback) => {
        this.#assertActive();
        assertCallback(callback, "onFrame");
        this.#frames.push(callback);
      },
      onMatrixUpdateAt: (callback) => {
        this.#assertActive();
        assertCallback(callback, "onMatrixUpdateAt");
        this.#matrixUpdates.push(callback);
        for (const [index, matrix] of this.#matrices.entries()) {
          callback(index, matrix.clone());
        }
      },
      isPreview: options.isPreview,
      scene: this.scene,
    };
  }

  bindScene(scene: GLTSScene): void {
    this.#bindScene?.(scene);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.nested.close();
    const errors: unknown[] = [];
    for (const callback of [...this.#disposals].reverse()) {
      try {
        callback();
      } catch (error) {
        errors.push(error);
      }
    }

    for (const object of [...this.#physicsObjects].reverse()) {
      try {
        object.dispose();
      } catch (error) {
        errors.push(error);
      }
    }
    this.#physicsObjects.clear();
    this.#disposals.length = 0;
    this.#frames.length = 0;
    this.#matrixUpdates.length = 0;

    if (errors.length > 0) {
      throw new AggregateError(errors, "GLTS disposal callbacks failed");
    }
  }

  setMatrixAt(index: number, matrix: THREE.Matrix4): void {
    for (const callback of this.#matrixUpdates) {
      callback(index, matrix.clone());
    }
  }

  update(delta: number): void {
    for (const callback of this.#frames) {
      callback(delta);
    }
  }

  #assertActive(): void {
    if (this.#disposed) throw new Error("GLTS execution has been disposed");
  }
}
