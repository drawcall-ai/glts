import type * as THREE from "three";

import { cleanUpAndThrow, GLTSError, toGLTSError } from "../errors.js";
import type { CompiledScript, ScriptModules } from "../modules/scripts.js";
import { Execution, type DisposeNodes } from "../scene/execution.js";
import type { GLTSScriptLoader } from "../types.js";
import { LoadingScope } from "./loading.js";

interface ExecutionRequest {
  readonly matrices: readonly THREE.Matrix4[];
  readonly isPreview: boolean;
  readonly instances: boolean;
  readonly parent?: Execution | undefined;
  readonly requestedURL: string;
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
    primary,
    new AggregateError([primary, nested])
  );
}

export class Construction {
  readonly #contextLoader: (owner: Execution) => GLTSScriptLoader;
  readonly #disposeNodes: DisposeNodes;
  readonly #manager: THREE.LoadingManager;
  readonly #modules: ScriptModules;
  readonly #signal: AbortSignal;

  constructor(options: {
    contextLoader: (owner: Execution) => GLTSScriptLoader;
    disposeNodes: DisposeNodes;
    manager: THREE.LoadingManager;
    modules: ScriptModules;
    signal: AbortSignal;
  }) {
    this.#contextLoader = options.contextLoader;
    this.#disposeNodes = options.disposeNodes;
    this.#manager = options.manager;
    this.#modules = options.modules;
    this.#signal = options.signal;
  }

  async construct(
    script: CompiledScript,
    { matrices, isPreview, instances, parent, requestedURL }: ExecutionRequest
  ): Promise<Execution> {
    this.#signal.throwIfAborted();
    const execution = new Execution(matrices, [requestedURL, script.url], this.#disposeNodes, parent);
    const scope = new LoadingScope(this.#manager, script.url);
    const cancel = (): void => scope.cancel(this.#signal.reason);
    this.#signal.addEventListener("abort", cancel);
    try {
      await this.#modules.evaluate(script, execution.context({
        gltsLoader: this.#contextLoader(execution),
        isPreview,
        loadingManager: scope.manager
      }));
      await execution.nested.finish();
      execution.nested.assertAttached(execution.scene);
      await scope.waitAndClose();
      if (instances) {
        execution.prepareInstances(script.url);
      }
      return execution;
    } catch (error) {
      let failure = error;
      scope.cancel(failure);
      try {
        await execution.nested.finish();
      } catch (nested) {
        failure = nestedFailure(script.url, failure, nested);
      }
      cleanUpAndThrow(failure, script.url, () => execution.dispose());
    } finally {
      this.#signal.removeEventListener("abort", cancel);
    }
  }
}
