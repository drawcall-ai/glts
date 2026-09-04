import * as THREE from "three";

import { Execution } from "./execution.js";
import { GLTSError, toGLTSError } from "./errors.js";
import { createAutoInstances, type AutoInstances } from "./instances.js";
import { LoadingScope } from "./loading.js";
import {
  ManagedNodes,
  type NodeRecord,
  type PreparedExecution
} from "./managed-nodes.js";
import { ModuleGraph, type PreparedScript } from "./module-graph.js";
import { Operations } from "./operations.js";
import type {
  GLTSInstances,
  GLTSScene,
  GLTSScriptLoader
} from "./types.js";

interface RuntimeOptions {
  readonly contextLoader: (owner: Execution) => GLTSScriptLoader;
  readonly manager: THREE.LoadingManager;
  readonly modules: ModuleGraph;
}

function identityMatrices(count: number): THREE.Matrix4[] {
  return Array.from({ length: count }, () => new THREE.Matrix4());
}

function cleanupFailure(url: string, error: unknown, cleanup: unknown): GLTSError {
  return new GLTSError(
    "GLTS operation and cleanup both failed",
    { phase: "dispose", url },
    new AggregateError([error, cleanup])
  );
}

function nestedFailure(url: string, error: unknown, nested: unknown): GLTSError {
  const primary = toGLTSError(error, "Unable to execute GLTS script", {
    phase: "evaluate",
    url
  });
  if (
    nested instanceof AggregateError &&
    nested.errors.length === 1 &&
    nested.errors[0] === error
  ) {
    return primary;
  }

  return new GLTSError(
    "GLTS execution and nested operation both failed",
    {
      importChain: primary.importChain,
      phase: primary.phase,
      url: primary.url
    },
    new AggregateError([primary, nested])
  );
}

export class LoaderRuntime {
  readonly #contextLoader: (owner: Execution) => GLTSScriptLoader;
  readonly #manager: THREE.LoadingManager;
  readonly #modules: ModuleGraph;
  readonly #nodes: ManagedNodes;
  readonly #operations: Operations;
  readonly #scopes = new Set<LoadingScope>();

  constructor(options: RuntimeOptions) {
    this.#contextLoader = options.contextLoader;
    this.#manager = options.manager;
    this.#modules = options.modules;
    this.#operations = new Operations(options.manager);
    this.#nodes = new ManagedNodes((record) =>
      this.#operations.write(
        record.url,
        () => this.#reloadRecords(record.url, [record])
      )
    );
  }

  load(
    url: string,
    isPreview: boolean,
    parent?: Execution
  ): Promise<GLTSScene> {
    return this.#read(url, parent, () => this.#track(url, async () => {
      const script = await this.#modules.prepare(url, false);
      const matrices = identityMatrices(1);
      const prepared = await this.#execute(
        script,
        matrices,
        isPreview,
        false,
        parent,
        url
      );
      this.#operations.assertActive(url);
      try {
        return this.#nodes.createScene(prepared, url, isPreview, matrices);
      } catch (error) {
        throw toGLTSError(error, "Unable to construct GLTS scene", {
          phase: "construct",
          url
        });
      }
    }));
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

    return this.#read(url, parent, () => this.#track(url, async () => {
      const script = await this.#modules.prepare(url, false);
      const matrices = identityMatrices(count);
      const prepared = await this.#execute(
        script,
        matrices,
        isPreview,
        true,
        parent,
        url
      );
      this.#operations.assertActive(url);
      try {
        return this.#nodes.createInstances(prepared, url, isPreview, matrices);
      } catch (error) {
        throw toGLTSError(error, "Unable to construct GLTS instances", {
          phase: "construct",
          url
        });
      }
    }));
  }

  reload(url: string): Promise<void> {
    this.#operations.assertActive(url);
    return this.#operations.write(url, async () => {
      const records = this.#nodes.records(url);
      if (records.length > 0) {
        await this.#reloadRecords(url, records);
      }
    });
  }

  dispose(): void {
    this.#operations.dispose();
    const reason = new GLTSError("Loader has been disposed", {
      phase: "dispose",
      url: "glts://loader"
    });
    for (const scope of this.#scopes) {
      scope.cancel(reason);
    }

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

  async #execute(
    script: PreparedScript,
    matrices: readonly THREE.Matrix4[],
    isPreview: boolean,
    instances: boolean,
    parent: Execution | undefined,
    requestedURL: string
  ): Promise<PreparedExecution> {
    this.#operations.assertActive(script.url);
    const execution = new Execution(matrices, [requestedURL, script.url], parent);
    const scope = new LoadingScope(this.#manager, script.url);
    this.#scopes.add(scope);
    let automatic: AutoInstances | undefined;
    try {
      await this.#modules.execute(script, execution.context({
        gltsLoader: this.#contextLoader(execution),
        isPreview,
        loadingManager: scope.manager
      }));
      await execution.settleNested();
      await scope.waitForIdle();

      if (instances && !execution.nativeInstances) {
        if (execution.animated) {
          throw new GLTSError(
            "Automatically instanced scripts cannot use onFrame(); implement native instancing with onMatrixUpdateAt()",
            { phase: "construct", url: script.url }
          );
        }
        if (execution.ownedNodes().length > 0) {
          throw new GLTSError(
            "Automatically instanced scripts cannot contain nested GLTS scenes; implement native instancing with onMatrixUpdateAt()",
            { phase: "construct", url: script.url }
          );
        }
        automatic = createAutoInstances(execution.scene, matrices, script.url);
      }

      this.#operations.assertActive(script.url);
      return { automatic, execution };
    } catch (error) {
      let failure = error;
      scope.cancel(failure);
      if (!execution.closed) {
        try {
          await execution.settleNested();
        } catch (nested) {
          failure = nestedFailure(script.url, failure, nested);
        }
      }
      try {
        this.#nodes.disposeExecution(execution, execution.scene, automatic);
      } catch (cleanup) {
        throw cleanupFailure(script.url, failure, cleanup);
      }
      throw failure;
    } finally {
      this.#scopes.delete(scope);
    }
  }

  async #reloadRecords(url: string, records: readonly NodeRecord[]): Promise<void> {
    await this.#track(url, async () => {
      const script = await this.#modules.prepare(url, true);
      const replacements: {
        readonly prepared: PreparedExecution;
        readonly record: NodeRecord;
      }[] = [];

      try {
        for (const record of records) {
          const prepared = await this.#execute(
            script,
            record.matrices,
            record.isPreview,
            record.type === "instances",
            undefined,
            url
          );
          replacements.push({ prepared, record });
        }
      } catch (error) {
        this.#disposeReplacements(url, replacements, error);
      }

      this.#operations.assertActive(url);
      const disposed = replacements.find(({ record }) => record.disposed);
      if (disposed) {
        this.#disposeReplacements(
          url,
          replacements,
          new GLTSError("GLTS node was disposed during reload", {
            phase: "reload",
            url: disposed.record.url
          })
        );
      }

      const disposalErrors: unknown[] = [];
      for (const { prepared, record } of replacements) {
        if (record.disposed) {
          try {
            this.#nodes.disposeExecution(
              prepared.execution,
              prepared.execution.scene,
              prepared.automatic
            );
          } catch (error) {
            disposalErrors.push(error);
          }
          continue;
        }

        try {
          this.#nodes.replace(record, prepared);
        } catch (error) {
          disposalErrors.push(error);
        }
      }
      this.#modules.activate(url, script);

      if (disposalErrors.length > 0) {
        throw new GLTSError(
          "Reload committed, but cleanup failed",
          { phase: "dispose", url },
          new AggregateError(disposalErrors)
        );
      }
    });
  }

  #disposeReplacements(
    url: string,
    replacements: readonly {
      readonly prepared: PreparedExecution;
      readonly record: NodeRecord;
    }[],
    error: unknown
  ): never {
    const cleanupErrors: unknown[] = [];
    for (const { prepared } of replacements) {
      try {
        this.#nodes.disposeExecution(
          prepared.execution,
          prepared.execution.scene,
          prepared.automatic
        );
      } catch (cleanup) {
        cleanupErrors.push(cleanup);
      }
    }

    if (cleanupErrors.length > 0) {
      throw cleanupFailure(url, error, new AggregateError(cleanupErrors));
    }
    throw error;
  }

  #track<T>(url: string, operation: () => Promise<T>): Promise<T> {
    return this.#operations.track(url, operation, (value) => {
      if (value instanceof THREE.Scene) {
        this.#nodes.dispose(value);
      }
    });
  }

  #read<T>(
    url: string,
    parent: Execution | undefined,
    operation: () => Promise<T>
  ): Promise<T> {
    if (parent) {
      return this.#operations.readNested(url, operation);
    }

    return this.#operations.read(url, operation);
  }
}
