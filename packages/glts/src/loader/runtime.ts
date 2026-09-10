import type { PhysicsWorld } from "@drawcall/physics";
import * as THREE from "three";

import type { Execution } from "../scene/execution.js";
import { GLTSError, toGLTSError } from "../errors.js";
import { Construction } from "./construction.js";
import { reloadRecords } from "./reload.js";
import type { Revision } from "../scene/revision.js";
import {
  ManagedNodes,
  type NodeRecord
} from "../scene/registry.js";
import type { ScriptModules } from "../modules/scripts.js";
import { Operations } from "./operations.js";
import type {
  GLTSInstances,
  GLTSScene,
  GLTSScriptLoader
} from "../types.js";

interface RuntimeOptions {
  readonly physicsWorld: PhysicsWorld | undefined;
  readonly contextLoader: (owner: Execution) => GLTSScriptLoader;
  readonly manager: THREE.LoadingManager;
  readonly modules: ScriptModules;
}

interface LoadRequest {
  readonly url: string;
  readonly count: number;
  readonly isPreview: boolean;
  readonly instances: boolean;
  readonly parent: Execution | undefined;
}

function identityMatrices(count: number): THREE.Matrix4[] {
  return Array.from({ length: count }, () => new THREE.Matrix4());
}

export class LoaderRuntime {
  readonly #modules: ScriptModules;
  readonly #nodes: ManagedNodes;
  readonly #operations: Operations;
  readonly #construction: Construction;

  constructor(options: RuntimeOptions) {
    this.#modules = options.modules;
    this.#operations = new Operations(options.manager);
    this.#nodes = new ManagedNodes((record) =>
      this.#operations.runReload(
        record.url,
        () => this.#reloadRecords(record.url, [record])
      )
    );
    this.#construction = new Construction({
      ...options, nodes: this.#nodes, operations: this.#operations
    });
  }

  load(url: string, isPreview: boolean, parent?: Execution): Promise<GLTSScene> {
    return this.#load({ url, count: 1, isPreview, parent, instances: false },
      (revision, matrices) => this.#nodes.createScene(revision, url, isPreview, matrices));
  }

  loadInstances(
    url: string,
    count: number,
    isPreview: boolean,
    parent?: Execution
  ): Promise<GLTSInstances> {
    if (!Number.isSafeInteger(count) || count < 1) {
      return Promise.reject(new RangeError("GLTS instance count must be a positive integer"));
    }
    return this.#load({ url, count, isPreview, parent, instances: true },
      (revision, matrices) => this.#nodes.createInstances(revision, url, isPreview, matrices));
  }

  #load<T extends GLTSScene>(
    request: LoadRequest,
    create: (revision: Revision, matrices: THREE.Matrix4[]) => T
  ): Promise<T> {
    const { url, parent, count, ...options } = request;
    return this.#runLoad(url, parent, () => this.#runWithProgress(url, async () => {
      const script = await this.#modules.prepareScript(url);
      const matrices = identityMatrices(count);
      const revision = await this.#construction.execute(script, {
        ...options, matrices, parent, requestedURL: url
      });
      this.#operations.assertActive(url);
      try {
        return create(revision, matrices);
      } catch (error) {
        throw toGLTSError(error, `Unable to construct GLTS ${options.instances ? "instances" : "scene"}`, {
          phase: "construct", url
        });
      }
    }));
  }

  reload(url: string): Promise<void> {
    this.#operations.assertActive(url);
    return this.#operations.runReload(url, async () => {
      const records = this.#nodes.recordsForURL(url);
      if (records.length > 0) {
        await this.#reloadRecords(url, records);
      }
    });
  }

  dispose(): void {
    this.#operations.dispose();
    this.#construction.dispose();

    try {
      this.#nodes.disposeAll();
    } catch (error) {
      throw new GLTSError(
        "Loader disposal failed",
        { phase: "dispose", url: "glts://loader" },
        error
      );
    }
  }

  #reloadRecords(url: string, records: readonly NodeRecord[]): Promise<void> {
    return this.#runWithProgress(url, () => reloadRecords(url, records, {
      modules: this.#modules,
      nodes: this.#nodes,
      construction: this.#construction,
      operations: this.#operations
    }));
  }

  #runWithProgress<T>(url: string, operation: () => Promise<T>): Promise<T> {
    return this.#operations.runWithProgress(url, operation, (value) => {
      if (value instanceof THREE.Scene) {
        this.#nodes.dispose(value);
      }
    });
  }

  #runLoad<T>(
    url: string,
    parent: Execution | undefined,
    operation: () => Promise<T>
  ): Promise<T> {
    if (parent) {
      return this.#operations.runNestedLoad(url, operation);
    }

    return this.#operations.runLoad(url, operation);
  }
}
