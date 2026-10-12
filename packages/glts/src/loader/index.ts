import { Loader, Matrix4, type LoadingManager } from "three";

import { cleanUpAndThrow, GLTSError, runAll, toGLTSError } from "../errors.js";
import { canonicalize } from "../modules/fetch.js";
import { defaultCDNURL } from "../modules/resolution.js";
import { ScriptModules } from "../modules/scripts.js";
import type { Execution } from "../scene/execution.js";
import { ManagedNodes } from "../scene/nodes.js";
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
import { Construction } from "./construction.js";
import { trackItem } from "./loading.js";
import { URLLocks } from "./locks.js";
import { reloadRecords } from "./reload.js";

interface LoadRequest {
  readonly url: string;
  readonly count: number;
  readonly isPreview: boolean;
  readonly instances: boolean;
  readonly parent: Execution | undefined;
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
  readonly #construction: Construction;
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
    this.#construction = new Construction({
      contextLoader: (owner, scriptURL) => this.#contextLoader(owner, scriptURL),
      disposeNodes: (root, owned) => this.#nodes.disposeNested(root, owned),
      manager,
      modules: this.#modules,
      signal: this.#lifetime.signal
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
    return this.#loadInstances(this.#resolveURL(url), count, this.#isPreview);
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
    return this.#load({ url, count: 1, isPreview, parent, instances: false },
      (execution, matrices) => this.#nodes.createScene(execution, url, isPreview, matrices));
  }

  async #loadInstances(url: string, count: number, isPreview: boolean, parent?: Execution): Promise<GLTSInstances> {
    if (!Number.isSafeInteger(count) || count < 1) {
      throw new RangeError("GLTS instance count must be a positive integer");
    }
    return this.#load({ url, count, isPreview, parent, instances: true },
      (execution, matrices) => this.#nodes.createInstances(execution, url, isPreview, matrices));
  }

  #load<T extends GLTSScene>(
    { url, count, parent, ...options }: LoadRequest,
    create: (execution: Execution, matrices: Matrix4[]) => T
  ): Promise<T> {
    // A nested load may pass a queued write so its parent, which holds a read, can finish.
    const lock = parent ? this.#locks.acquireReadBeforeQueuedWrite(url) : this.#locks.acquireRead(url);
    return this.#locked(lock, () => trackItem(this.manager, url, this.#lifetime.signal, async () => {
      const script = await this.#modules.prepareScript(url);
      const matrices = Array.from({ length: count }, () => new Matrix4());
      const execution = await this.#construction.construct(script, {
        ...options, matrices, parent, requestedURL: url
      });
      try {
        this.#lifetime.signal.throwIfAborted();
        return create(execution, matrices);
      } catch (error) {
        cleanUpAndThrow(
          toGLTSError(error, `Unable to construct GLTS ${options.instances ? "instances" : "scene"}`, {
            phase: "construct", url
          }),
          url,
          () => execution.dispose()
        );
      }
    }, (node) => node.dispose()));
  }

  #reloadScript(url: string): Promise<void> {
    return this.#locked(this.#locks.acquireWrite(url), async () => {
      // The write lock lets pending loads finish before their source is invalidated.
      this.#modules.invalidateScript(url);
      const records = this.#nodes.recordsForURL(url);
      if (records.length === 0) return;
      await trackItem(this.manager, url, this.#lifetime.signal, () =>
        reloadRecords(url, records, { construction: this.#construction, modules: this.#modules }));
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
      loadInstancesAsync: (url, count) =>
        owner.nested.own(this.#loadInstances(resolve(url), count, false, owner))
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
