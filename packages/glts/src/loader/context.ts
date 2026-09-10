import { GLTSError } from "../errors.js";
import type { Execution } from "../scene/execution.js";
import type { GLTSScene, GLTSScriptLoader, GLTSURL } from "../types.js";
import type { LoaderRuntime } from "./runtime.js";

export function createContextLoader(
  owner: Execution,
  runtime: LoaderRuntime,
  resolveURL: (url: GLTSURL) => string
): GLTSScriptLoader {
  const resolve = (url: GLTSURL): string => {
    const resolved = resolveURL(url);
    owner.nested.assertCanLoad(resolved);
    return resolved;
  };
  const loader = {
    loadAsync: (url: GLTSURL) =>
      trackOwnedLoad(owner, runtime.load(resolve(url), false, owner)),
    loadInstancesAsync: (url: GLTSURL, count: number) =>
      trackOwnedLoad(owner, runtime.loadInstances(resolve(url), count, false, owner)),
    reload: () => owner.nested.track(Promise.reject(new GLTSError(
      "The contextual gltsLoader cannot reload the live graph",
      { phase: "reload", url: "glts://context-loader" }
    ))),
    dispose: () => {
      throw new GLTSError("The contextual gltsLoader cannot be disposed by a script", {
        phase: "dispose", url: "glts://context-loader"
      });
    }
  };
  return loader;
}

function trackOwnedLoad<T extends GLTSScene>(owner: Execution, promise: Promise<T>): Promise<T> {
  const owned = promise.then((value) => {
    try {
      owner.nested.own(value);
    } catch (error) {
      try {
        value.dispose();
      } catch (cleanup) {
        throw new GLTSError(
          "Nested GLTS ownership and cleanup both failed",
          { phase: "dispose", url: value.url },
          new AggregateError([error, cleanup])
        );
      }
      throw error;
    }
    return value;
  });
  return owner.nested.track(owned);
}

