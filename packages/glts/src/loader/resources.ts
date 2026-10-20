import * as THREE from "three";

import type { Dependencies } from "../dependencies.js";
import { collectError, GLTSError } from "../errors.js";
import { canonicalize, pageBase } from "../urls.js";

export interface ResourcesOptions {
  /** The host's manager, which gets the items and resolves their URLs. */
  readonly host: THREE.LoadingManager;
  /** The URL of the script the execution runs. */
  readonly url: string;
  /** The execution's dependencies, which get its http(s) and file resources. */
  readonly dependencies: Dependencies;
  /** Throws unless resources may still start. */
  readonly assertOpen: () => void;
}

/**
 * One execution's contextual loadingManager, which reports its items to the host's manager, observes the files
 * they load, and collects their failures.
 */
export class Resources {
  readonly manager = new THREE.LoadingManager();
  readonly #host: THREE.LoadingManager;
  readonly #url: string;
  readonly #dependencies: Dependencies;
  readonly #failedURLs: string[] = [];
  /** Failures of the managers' callbacks. */
  readonly #callbackErrors: unknown[] = [];
  #items = 0;
  #idle: { readonly resolve: () => void; readonly reject: (reason: unknown) => void } | undefined;

  constructor(options: ResourcesOptions) {
    this.#host = options.host;
    this.#url = options.url;
    this.#dependencies = options.dependencies;
    this.#scopeManager(options.assertOpen);
  }

  /** Resolves once no resource is loading, or rejects with the reason of abort(). */
  async idle(): Promise<void> {
    if (this.#items === 0) return;
    await new Promise<void>((resolve, reject) => {
      this.#idle = { resolve, reject };
    });
  }

  /** Throws the failures of the resources and the managers' callbacks. */
  assertLoaded(): void {
    if (this.#failedURLs.length === 0 && this.#callbackErrors.length === 0) return;

    const failedURLs = this.#failedURLs.map((url) => `- ${url}`).join("\n");
    const message = failedURLs ? `Resources failed to load:\n${failedURLs}` : "LoadingManager callback failed";
    const cause = this.#callbackErrors.length > 0
      ? new AggregateError(this.#callbackErrors, "LoadingManager callbacks failed")
      : undefined;
    throw new GLTSError(message, { phase: "resource", url: this.#url }, cause);
  }

  /** Aborts the loading resources and rejects idle() with `reason`. */
  abort(reason: unknown): void {
    this.manager.abort();
    this.#idle?.reject(reason);
  }

  /** Adds the http(s) or file resource at `url` to the dependencies. */
  #observe(url: string): void {
    // Three resolves relative resource URLs against the page, not the GLTS source.
    const base = pageBase();
    if (!URL.canParse(url, base)) return;
    const resource = new URL(url, base);
    if (!["http:", "https:", "file:"].includes(resource.protocol)) return;
    this.#dependencies.add(canonicalize(resource));
  }

  /** Makes the manager report to the host, observe its resources, and count its items. */
  #scopeManager(assertOpen: () => void): void {
    const host = this.#host;
    const manager = this.manager;
    const itemStart = manager.itemStart.bind(manager);
    const itemEnd = manager.itemEnd.bind(manager);
    const itemError = manager.itemError.bind(manager);
    const getHandler = manager.getHandler.bind(manager);

    manager.resolveURL = (url): string => {
      const resolved = host.resolveURL(url);
      // FileLoader skips itemStart when joining another manager's in-flight request.
      this.#observe(url);
      if (resolved !== url) {
        this.#observe(resolved);
      }
      return resolved;
    };
    manager.getHandler = (url) => {
      const handler = getHandler(url);
      if (handler) {
        return handler;
      }
      if (host.getHandler(url)) {
        throw new GLTSError(
          "Host LoadingManager handlers cannot be scoped; register the handler with the contextual loadingManager",
          { phase: "resource", url: this.#url }
        );
      }
      return null;
    };
    manager.itemStart = (url): void => {
      assertOpen();
      this.#observe(url);
      this.#items += 1;
      collectError(this.#callbackErrors, () => itemStart(url));
      collectError(this.#callbackErrors, () => host.itemStart(url));
    };
    manager.itemError = (url): void => {
      this.#failedURLs.push(url);
      collectError(this.#callbackErrors, () => itemError(url));
      collectError(this.#callbackErrors, () => host.itemError(url));
    };
    manager.itemEnd = (url): void => {
      if (this.#items === 0) {
        throw new Error(`LoadingManager item ended without a matching start: ${url}`);
      }

      this.#items -= 1;
      collectError(this.#callbackErrors, () => itemEnd(url));
      collectError(this.#callbackErrors, () => host.itemEnd(url));
      if (this.#items === 0) this.#idle?.resolve();
    };
  }
}
