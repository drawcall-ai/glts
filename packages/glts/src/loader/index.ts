import { Loader, Matrix4, type LoadingManager } from "three";

import { cleanUpAndThrow, GLTSError, runAll, toGLTSError } from "../errors.js";
import { canonicalize } from "../modules/fetch.js";
import { defaultCDNURL } from "../modules/resolution.js";
import { ScriptModules, type LinkedScript } from "../modules/scripts.js";
import { Execution } from "../scene/execution.js";
import { ManagedNodes, type LoadRequest } from "../scene/nodes.js";
import type {
  GLTSErrorCallback,
  GLTSInstances,
  GLTSLoadCallback,
  GLTSLoaderOptions,
  GLTSProgressCallback,
  GLTSScene,
  GLTSScriptLoader,
  GLTSURL
} from "../types.js";
import { LoadingScope, trackItem } from "./loading.js";
import { URLLocks } from "./locks.js";
import { reloadRecords } from "./reload.js";

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

/** Resolves `url` against the page's base URL; without a page, only an absolute `url` resolves. */
function pageURL(url: GLTSURL): URL {
  const base = typeof document !== "undefined" ? document.baseURI
    : typeof location !== "undefined" ? location.href
    : undefined;
  if (base !== undefined) return new URL(url, base);
  if (URL.canParse(url)) return new URL(url);
  throw new GLTSError("A relative URL needs document.baseURI or location.href to resolve against", {
    phase: "resolve",
    url: String(url)
  });
}

export class GLTSLoader extends Loader {
  readonly #isPreview: boolean;
  readonly #modules: ScriptModules;
  readonly #lifetime = new AbortController();
  readonly #locks = new URLLocks();
  readonly #nodes = new ManagedNodes();

  constructor(
    manager: LoadingManager,
    options: GLTSLoaderOptions = {}
  ) {
    super(manager);
    if (!manager) {
      throw new TypeError("GLTSLoader requires a Three.js LoadingManager");
    }

    this.#isPreview = options.isPreview ?? false;
    this.#modules = new ScriptModules({
      cdnURL: pageURL(options.cdnURL ?? defaultCDNURL),
      fetch: (input, init) => this.#fetch(input, init),
      modules: options.modules
    });
  }

  override load(
    url: GLTSURL,
    onLoad: GLTSLoadCallback,
    onProgress?: GLTSProgressCallback,
    onError?: GLTSErrorCallback
  ): void {
    void this.loadAsync(url, onProgress).then(onLoad, (error: unknown) => {
      if (onError) {
        onError(error);
        return;
      }

      console.error(error);
    });
  }

  override async loadAsync(
    url: GLTSURL,
    onProgress?: GLTSProgressCallback
  ): Promise<GLTSScene> {
    const resolvedURL = this.#resolveURL(url);
    if (onProgress) {
      throw new GLTSError(
        "GLTSLoader does not support per-load progress callbacks; use LoadingManager.onProgress",
        { phase: "resolve", url: resolvedURL }
      );
    }
    return this.#loadScene(resolvedURL, this.#isPreview);
  }

  async loadInstancesAsync(url: GLTSURL, count: number): Promise<GLTSInstances> {
    return this.#loadInstances(this.#resolveURL(url), count);
  }

  /**
   * Invalidates the source of the script at `url`, or of every script importing the helper at `url`,
   * and reloads their undisposed nodes. Unloaded source is fetched on the next load.
   */
  async reload(url: GLTSURL): Promise<void> {
    const resolvedURL = this.#resolveURL(url);
    this.#lifetime.signal.throwIfAborted();
    const dependents = this.#modules.dependents(resolvedURL);
    if (dependents.length === 0) return this.#reloadScript(resolvedURL);

    const results = await Promise.allSettled(dependents.map((script) => this.#reloadScript(script)));
    const errors: unknown[] = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new GLTSError(
        "Reloading the helper's scripts failed",
        { phase: "reload", url: resolvedURL },
        new AggregateError(errors)
      );
    }
  }

  dispose(): void {
    if (this.#lifetime.signal.aborted) return;
    this.#lifetime.abort(new GLTSError("Loader has been disposed", { phase: "dispose", url: "glts://loader" }));
    runAll("Loader disposal failed", [() => this.#nodes.disposeAll(), () => this.#modules.dispose()]);
  }

  #loadScene(url: string, isPreview: boolean, parent?: Execution): Promise<GLTSScene> {
    const request = { url, matrices: [new Matrix4()], isPreview, instances: false };
    return this.#load(request, parent, (execution) => this.#nodes.createScene(execution, request));
  }

  async #loadInstances(url: string, count: number, parent?: Execution): Promise<GLTSInstances> {
    if (!Number.isSafeInteger(count) || count < 1) {
      throw new RangeError("GLTS instance count must be a positive integer");
    }
    // Instances are never the standalone asset a preview shows.
    const matrices = Array.from({ length: count }, () => new Matrix4());
    const request = { url, matrices, isPreview: false, instances: true };
    return this.#load(request, parent, (execution) => this.#nodes.createInstances(execution, request));
  }

  #load<T extends GLTSScene>(
    request: LoadRequest,
    parent: Execution | undefined,
    create: (execution: Execution) => T
  ): Promise<T> {
    const { url } = request;
    // A nested load may pass a queued write so its parent, which holds a read, can finish.
    const lock = parent ? this.#locks.acquireReadBeforeQueuedWrite(url) : this.#locks.acquireRead(url);
    return this.#locked(lock, () => trackItem(this.manager, url, this.#lifetime.signal, async () => {
      const execution = await this.#construct(await this.#modules.getScript(url), request, parent);
      try {
        this.#lifetime.signal.throwIfAborted();
        return create(execution);
      } catch (error) {
        cleanUpAndThrow(
          toGLTSError(error, `Unable to construct GLTS ${request.instances ? "instances" : "scene"}`, {
            phase: "construct", url
          }),
          url,
          () => execution.dispose()
        );
      }
    }, (node) => node.dispose()));
  }

  /** Runs `script` for `request` and waits for its nested loads and resources. */
  async #construct(script: LinkedScript, request: LoadRequest, parent?: Execution): Promise<Execution> {
    const signal = this.#lifetime.signal;
    signal.throwIfAborted();
    const execution = new Execution(
      request.matrices,
      [request.url, script.url],
      (root, owned) => this.#nodes.disposeNested(root, owned),
      parent
    );
    const scope = new LoadingScope(this.manager, script.url);
    const cancel = (): void => scope.cancel(signal.reason);
    signal.addEventListener("abort", cancel);
    try {
      await this.#modules.evaluate(script, execution.context({
        gltsLoader: this.#contextLoader(execution, script.url),
        isPreview: request.isPreview,
        loadingManager: scope.manager
      }));
      await execution.nested.finish();
      execution.nested.assertAttached(execution.scene);
      await scope.waitAndClose();
      if (request.instances) {
        execution.autoInstance(script.url);
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
      signal.removeEventListener("abort", cancel);
    }
  }

  #reloadScript(url: string): Promise<void> {
    return this.#locked(this.#locks.acquireWrite(url), async () => {
      // The write lock lets pending loads finish before their source is invalidated.
      this.#modules.invalidateScript(url);
      const records = this.#nodes.recordsForURL(url);
      if (records.length === 0) return;
      await trackItem(this.manager, url, this.#lifetime.signal, () =>
        reloadRecords(url, records, this.#modules, (script, request) => this.#construct(script, request)));
    });
  }

  async #locked<T>(lock: Promise<() => void>, operation: () => Promise<T>): Promise<T> {
    const release = await lock;
    try {
      this.#lifetime.signal.throwIfAborted();
      return await operation();
    } finally {
      release();
    }
  }

  /** The `gltsLoader` of a script at `scriptURL`, resolving relative URLs against it. */
  #contextLoader(owner: Execution, scriptURL: string): GLTSScriptLoader {
    const resolve = (url: GLTSURL): string => {
      const resolved = canonicalize(new URL(this.manager.resolveURL(String(url)), scriptURL));
      owner.nested.assertCanLoad(resolved);
      return resolved;
    };
    return {
      loadAsync: (url) => owner.nested.own(this.#loadScene(resolve(url), false, owner)),
      loadInstancesAsync: (url, count) => owner.nested.own(this.#loadInstances(resolve(url), count, owner))
    };
  }

  #resolveURL(url: GLTSURL): string {
    const input = url instanceof URL ? url.href : `${this.path}${url}`;
    return canonicalize(pageURL(this.manager.resolveURL(input)));
  }

  #fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const headers = new Headers(init?.headers);
    for (const [name, value] of Object.entries(this.requestHeader)) {
      headers.set(name, value);
    }

    const requestInit: RequestInit = { ...init, headers };
    if (this.withCredentials) {
      requestInit.credentials = "include";
    }

    return globalThis.fetch(input, requestInit);
  }
}
