import type { PhysicsWorld } from "@drawcall/physics";
import type * as THREE from "three";
import { Execution } from "../scene/execution.js";
import { GLTSError, toGLTSError } from "../errors.js";
import { createAutoInstances, type AutoInstances } from "../scene/instances.js";
import type { ManagedNodes } from "../scene/registry.js";
import type { Revision } from "../scene/revision.js";
import type { ScriptModules, CompiledScript } from "../modules/scripts.js";
import type { GLTSScriptLoader } from "../types.js";
import type { Operations } from "./operations.js";
import { LoadingScope } from "./loading.js";

interface ExecutionRequest {
  readonly matrices: readonly THREE.Matrix4[];
  readonly isPreview: boolean;
  readonly instances: boolean;
  readonly parent?: Execution | undefined;
  readonly requestedURL: string;
  readonly physicsSource?: Execution;
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

export class Construction {
  readonly #scopes = new Set<LoadingScope>();
  readonly #physicsWorld: PhysicsWorld | undefined;
  readonly #contextLoader: (owner: Execution) => GLTSScriptLoader;
  readonly #manager: THREE.LoadingManager;
  readonly #modules: ScriptModules;
  readonly #nodes: ManagedNodes;
  readonly #operations: Operations;

  constructor(options: {
    physicsWorld: PhysicsWorld | undefined;
    contextLoader: (owner: Execution) => GLTSScriptLoader;
    manager: THREE.LoadingManager;
    modules: ScriptModules;
    nodes: ManagedNodes;
    operations: Operations;
  }) {
    this.#physicsWorld = options.physicsWorld;
    this.#contextLoader = options.contextLoader;
    this.#manager = options.manager;
    this.#modules = options.modules;
    this.#nodes = options.nodes;
    this.#operations = options.operations;
  }

  dispose(): void {
    const reason = new GLTSError("Loader has been disposed", {
      phase: "dispose", url: "glts://loader"
    });
    for (const scope of this.#scopes) {
      scope.cancel(reason);
    }
  }

  async execute(
    script: CompiledScript,
    { matrices, isPreview, instances, parent, requestedURL, physicsSource }: ExecutionRequest
  ): Promise<Revision> {
    this.#operations.assertActive(script.url);
    const world = this.#physicsWorld;
    const worldSource = physicsSource
      ? () => physicsSource.physicsWorld()
      : world ? () => Promise.resolve(world) : undefined;
    const execution = new Execution(matrices, [requestedURL, script.url], parent, worldSource);
    const scope = new LoadingScope(this.#manager, script.url);
    this.#scopes.add(scope);
    let automatic: AutoInstances | undefined;
    try {
      await this.#modules.executeScript(script, execution.context({
        gltsLoader: this.#contextLoader(execution),
        isPreview,
        loadingManager: scope.manager
      }));
      await execution.nested.finishAndValidateAttachment(execution.scene);
      await scope.waitAndClose();

      if (instances && execution.physics) {
        throw new GLTSError(
          "Physics assets do not support loadInstancesAsync(); load separate scenes instead",
          { phase: "construct", url: script.url }
        );
      }

      if (instances && !execution.nativeInstances) {
        if (execution.animated) {
          throw new GLTSError(
            "Automatically instanced scripts cannot use onFrame(); implement native instancing with onMatrixUpdateAt()",
            { phase: "construct", url: script.url }
          );
        }
        if (execution.nested.nodes.length > 0) {
          throw new GLTSError(
            "Automatically instanced scripts cannot contain nested GLTS scenes; implement native instancing with onMatrixUpdateAt()",
            { phase: "construct", url: script.url }
          );
        }
        automatic = createAutoInstances(execution.scene, matrices, script.url);
      }

      this.#operations.assertActive(script.url);
      return this.#nodes.createRevision(execution, automatic);
    } catch (error) {
      let failure = error;
      scope.cancel(failure);
      if (!execution.nested.closed) {
        try {
          await execution.nested.finishAndValidateAttachment(execution.scene);
        } catch (nested) {
          failure = nestedFailure(script.url, failure, nested);
        }
      }
      try {
        this.#nodes.createRevision(execution, automatic).dispose();
      } catch (cleanup) {
        throw cleanupFailure(script.url, failure, cleanup);
      }
      throw failure;
    } finally {
      this.#scopes.delete(scope);
    }
  }

}
