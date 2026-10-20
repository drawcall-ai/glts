import { LoadingManager, Matrix4 } from "three";

import { Dependencies } from "../../src/dependencies.js";
import { Execution } from "../../src/execution/index.js";

/** An execution of a script at a test URL, with a contextual gltsLoader that rejects nested loads. */
export function createExecution(options: {
  readonly url?: string;
  readonly module?: string;
  readonly matrices?: Matrix4[];
} = {}): Execution {
  const url = options.url ?? "https://example.test/scene.glts";
  return new Execution({
    script: { requestedURL: url, url, module: options.module ?? "data:text/javascript,export default () => {}" },
    request: { matrices: options.matrices ?? [new Matrix4()], isPreview: false, instanced: false },
    scope: {
      gltsLoader: {
        loadAsync: async () => { throw new Error("Unexpected nested load"); },
        loadInstancesAsync: async () => { throw new Error("Unexpected nested load"); }
      },
      manager: new LoadingManager(),
      nodes: [],
      settle: async () => undefined,
      abort: async () => [],
      dispose: () => undefined,
    },
    dependencies: new Dependencies(),
  });
}
