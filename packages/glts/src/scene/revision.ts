import type * as THREE from "three";
import type { Execution } from "./execution.js";
import type { AutoInstances } from "./instances.js";

export class Revision {
  readonly execution: Execution;
  readonly automatic: AutoInstances | undefined;
  readonly #disposeNested: (root: THREE.Object3D) => void;
  #disposed = false;

  constructor(
    execution: Execution,
    automatic: AutoInstances | undefined,
    disposeNested: (root: THREE.Object3D) => void
  ) {
    this.execution = execution;
    this.automatic = automatic;
    this.#disposeNested = disposeNested;
  }

  dispose(root: THREE.Object3D = this.execution.scene): void {
    if (this.#disposed) {
      root.clear();
      return;
    }
    this.#disposed = true;
    const errors: unknown[] = [];
    for (const dispose of [
      () => this.#disposeNested(root),
      () => this.automatic?.dispose(),
      () => this.execution.dispose()
    ]) {
      try {
        dispose();
      } catch (error) {
        errors.push(error);
      }
    }
    root.clear();
    if (errors.length > 0) {
      throw new AggregateError(errors, "GLTS execution disposal failed");
    }
  }
}
