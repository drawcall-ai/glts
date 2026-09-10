import type * as THREE from "three";

import { GLTSError } from "../errors.js";
import type { GLTSScene } from "../types.js";

export class NestedLoads {
  readonly #ancestors: ReadonlySet<string>;
  readonly #nodes = new Set<GLTSScene>();
  readonly #pending = new Set<Promise<unknown>>();
  readonly #failures: unknown[] = [];
  #accepting = true;

  constructor(urls: readonly string[], parent?: NestedLoads) {
    this.#ancestors = new Set([...(parent ? parent.#ancestors : []), ...urls]);
  }

  get closed(): boolean {
    return !this.#accepting;
  }

  close(): void {
    this.#accepting = false;
  }

  assertCanLoad(url: string): void {
    if (this.#ancestors.has(url)) {
      throw new GLTSError("Cyclic nested GLTS load", {
        importChain: [...this.#ancestors, url],
        phase: "resolve",
        url,
      });
    }

    if (!this.#accepting) {
      throw new GLTSError("The contextual gltsLoader is no longer active", {
        phase: "resolve",
        url,
      });
    }
  }

  own(node: GLTSScene): void {
    if (!this.#accepting) {
      throw new GLTSError(
        "Nested GLTS load completed after its parent closed",
        {
          phase: "dispose",
          url: node.url,
        },
      );
    }
    this.#nodes.add(node);
  }

  get nodes(): readonly GLTSScene[] {
    return [...this.#nodes];
  }

  async finishAndValidateAttachment(scene: THREE.Object3D): Promise<void> {
    while (this.#pending.size > 0) {
      await Promise.allSettled([...this.#pending]);
    }

    this.close();
    if (this.#failures.length > 0) {
      throw new AggregateError(this.#failures, "Nested GLTS operation failed");
    }

    this.#assertNodesAttached(scene);
  }

  #assertNodesAttached(scene: THREE.Object3D): void {
    const attached = new Set<THREE.Object3D>();
    scene.traverse((object) => attached.add(object));
    const orphan = [...this.#nodes].find((node) => !attached.has(node));
    if (orphan) {
      throw new GLTSError("Nested GLTS scenes must be added to scene", {
        phase: "construct",
        url: orphan.url,
      });
    }
  }

  track<T>(promise: Promise<T>): Promise<T> {
    this.#pending.add(promise);
    void promise.then(
      () => this.#pending.delete(promise),
      (error: unknown) => {
        this.#pending.delete(promise);
        this.#failures.push(error);
      },
    );
    return promise;
  }

}
