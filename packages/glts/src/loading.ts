import * as THREE from "three";

import { GLTSError } from "./errors.js";

interface Completion {
  readonly reject: (error: unknown) => void;
  readonly resolve: () => void;
}

export class LoadingScope {
  readonly manager: THREE.LoadingManager;
  readonly #errors: unknown[] = [];
  readonly #failedURLs: string[] = [];
  readonly #rootURL: string;
  #active = true;
  #completion: Completion | undefined;
  #pending = 0;

  constructor(host: THREE.LoadingManager, rootURL: string) {
    this.#rootURL = rootURL;
    const manager = new THREE.LoadingManager();
    const itemStart = manager.itemStart.bind(manager);
    const itemEnd = manager.itemEnd.bind(manager);
    const itemError = manager.itemError.bind(manager);
    const getHandler = manager.getHandler.bind(manager);

    manager.resolveURL = (url): string => host.resolveURL(url);
    manager.getHandler = (url) => {
      const handler = getHandler(url);
      if (handler) {
        return handler;
      }
      if (host.getHandler(url)) {
        throw new GLTSError(
          "Host LoadingManager handlers cannot be scoped; register the handler with the contextual loadingManager",
          { phase: "resource", url: this.#rootURL }
        );
      }
      return null;
    };
    manager.itemStart = (url): void => {
      this.#assertActive();
      this.#pending += 1;
      this.#notify(() => itemStart(url));
      this.#notify(() => host.itemStart(url));
    };
    manager.itemError = (url): void => {
      this.#failedURLs.push(url);
      this.#notify(() => itemError(url));
      this.#notify(() => host.itemError(url));
    };
    manager.itemEnd = (url): void => {
      if (this.#pending === 0) {
        throw new Error(`LoadingManager item ended without a matching start: ${url}`);
      }

      this.#pending -= 1;
      this.#notify(() => itemEnd(url));
      this.#notify(() => host.itemEnd(url));
      this.#settle();
    };
    this.manager = manager;
  }

  cancel(reason: unknown): void {
    if (!this.#active) {
      return;
    }

    this.#active = false;
    this.manager.abort();
    this.#completion?.reject(reason);
    this.#completion = undefined;
  }

  async waitForIdle(): Promise<void> {
    await Promise.resolve();
    this.#assertActive();
    if (this.#pending > 0) {
      await new Promise<void>((resolve, reject) => {
        this.#completion = { reject, resolve };
      });
    }

    this.#active = false;
    this.#throwFailures();
  }

  #assertActive(): void {
    if (!this.#active) {
      throw new GLTSError("Loading scope is no longer active", {
        phase: "dispose",
        url: this.#rootURL
      });
    }
  }

  #notify(callback: () => void): void {
    try {
      callback();
    } catch (error) {
      this.#errors.push(error);
    }
  }

  #settle(): void {
    if (this.#pending !== 0 || !this.#completion) {
      return;
    }

    const completion = this.#completion;
    this.#completion = undefined;
    completion.resolve();
  }

  #throwFailures(): void {
    if (this.#failedURLs.length === 0 && this.#errors.length === 0) {
      return;
    }

    const failures = this.#failedURLs.map((url) => `- ${url}`).join("\n");
    const message = failures
      ? `Resources failed to load:\n${failures}`
      : "LoadingManager callback failed";
    const cause = this.#errors.length > 0
      ? new AggregateError(this.#errors, "LoadingManager callbacks failed")
      : undefined;
    throw new GLTSError(message, {
      phase: "resource",
      url: this.#rootURL
    }, cause);
  }
}
