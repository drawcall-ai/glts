import { LoadingManager } from "three";

import { Dependencies } from "../../src/dependencies.js";
import { Execution } from "../../src/execution/index.js";
import { ScriptLoader } from "../../src/loader/script.js";

/** An execution of a script at a test URL, with a contextual gltsLoader that rejects nested loads. */
export function createExecution(options: {
  readonly url?: string;
  readonly module?: string;
} = {}): Execution {
  const url = options.url ?? "https://example.test/scene.glts";
  const module = options.module ?? "data:text/javascript,export default () => {}";
  const manager = new LoadingManager();
  const unexpected = async (): Promise<never> => { throw new Error("Unexpected nested load"); };
  return new Execution({
    script: { requestedURL: url, executionURL: url, module },
    request: { isPreview: false, count: undefined },
    scope: {
      gltsLoader: new ScriptLoader(manager, {}, unexpected, unexpected),
      manager,
      nodes: [],
      settle: async () => undefined,
      abort: async () => [],
      dispose: () => undefined,
    },
    dependencies: new Dependencies(),
  });
}

