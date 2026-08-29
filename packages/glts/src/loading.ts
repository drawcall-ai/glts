import { LoadingManager } from "three";

import { GLTSError } from "./errors.js";

interface LoadingBoundaryState {
  readonly failures: string[];
  readonly rootURL: string;
  status: "open" | "waiting" | "settled";
}

interface LoadingCompletion {
  readonly reject: (error: unknown) => void;
  readonly resolve: () => void;
}

function environmentBaseURL(): string | undefined {
  if (typeof document !== "undefined") {
    return document.baseURI;
  }

  if (typeof location !== "undefined") {
    return location.href;
  }

  return undefined;
}

function scopePrefix(runtimeKey: string): string {
  return `.__glts_runtime_${encodeURIComponent(runtimeKey)}_source_`;
}

function authority(target: URL): string {
  if (target.protocol === "file:") {
    return `file://${target.host}`;
  }

  const password = target.password ? `:${target.password}` : "";
  const credentials = target.username || target.password
    ? `${target.username}${password}@`
    : "";
  return `${target.protocol}//${credentials}${target.host}`;
}

function scopedURL(
  url: string,
  runtimeKey: string,
  baseURL: string | undefined
): string {
  let target: URL;
  try {
    target = baseURL ? new URL(url, baseURL) : new URL(url);
  } catch {
    return url;
  }

  const hierarchical = target.protocol === "http:"
    || target.protocol === "https:"
    || target.protocol === "file:";
  if (!hierarchical) {
    return url;
  }

  // Three.js coalesces requests globally by the raw manager-resolved URL. A
  // removable path segment isolates runtimes without changing the fetched URL.
  // Encoding the source in that segment also makes callback translation
  // stateless: resolve-only consumers cannot leave bookkeeping behind.
  const segment = `${scopePrefix(runtimeKey)}${encodeURIComponent(url)}`;
  return `${authority(target)}/${segment}/..${target.pathname}${target.search}${target.hash}`;
}

function recoverSourceURL(url: string, runtimeKey: string): string {
  const marker = `/${scopePrefix(runtimeKey)}`;
  const markerIndex = url.indexOf(marker);
  if (markerIndex === -1) {
    return url;
  }

  const sourceStart = markerIndex + marker.length;
  const sourceEnd = url.indexOf("/..", sourceStart);
  if (sourceEnd === -1) {
    return url;
  }

  try {
    return decodeURIComponent(url.slice(sourceStart, sourceEnd));
  } catch {
    return url;
  }
}

export interface LoadingBoundary {
  cancel(): void;
  waitForIdle(): Promise<void>;
}

export class RuntimeLoading {
  readonly manager = new LoadingManager();
  readonly #boundaries = new Set<LoadingBoundaryState>();
  readonly #completions = new Map<LoadingBoundaryState, LoadingCompletion>();
  readonly #activeFailures: string[] = [];
  #pending = 0;

  constructor(runtimeKey: string, baseURL?: string) {
    const itemStart = this.manager.itemStart.bind(this.manager);
    const itemEnd = this.manager.itemEnd.bind(this.manager);
    const itemError = this.manager.itemError.bind(this.manager);
    const resolveURL = this.manager.resolveURL.bind(this.manager);

    this.manager.resolveURL = (url): string => {
      const resolvedURL = resolveURL(url);
      const isolatedURL = scopedURL(
        resolvedURL,
        runtimeKey,
        baseURL ?? environmentBaseURL()
      );
      return isolatedURL;
    };

    this.manager.itemStart = (url): void => {
      const resourceURL = recoverSourceURL(url, runtimeKey);
      if (this.#pending === 0) {
        this.#activeFailures.length = 0;
      }
      this.#pending += 1;
      itemStart(resourceURL);
    };
    this.manager.itemError = (url): void => {
      const resourceURL = recoverSourceURL(url, runtimeKey);
      this.#activeFailures.push(resourceURL);
      for (const boundary of this.#boundaries) {
        boundary.failures.push(resourceURL);
      }
      itemError(resourceURL);
    };
    this.manager.itemEnd = (url): void => {
      const resourceURL = recoverSourceURL(url, runtimeKey);
      if (this.#pending === 0) {
        throw new Error(
          `Loading manager ended an untracked resource: ${resourceURL}`
        );
      }

      try {
        itemEnd(resourceURL);
      } finally {
        this.#pending -= 1;
        this.#settleIdleBoundaries();
        if (this.#pending === 0) {
          this.#activeFailures.length = 0;
        }
      }
    };
  }

  begin(rootURL: string): LoadingBoundary {
    const state: LoadingBoundaryState = {
      failures: this.#pending > 0 ? [...this.#activeFailures] : [],
      rootURL,
      status: "open"
    };
    this.#boundaries.add(state);

    return {
      cancel: () => this.#cancel(state),
      waitForIdle: () => this.#waitForIdle(state)
    };
  }

  #cancel(state: LoadingBoundaryState): void {
    if (state.status !== "open") {
      throw new Error("Only an open loading boundary can be cancelled");
    }

    state.status = "settled";
    this.#boundaries.delete(state);
  }

  #waitForIdle(state: LoadingBoundaryState): Promise<void> {
    if (state.status !== "open") {
      return Promise.reject(new Error("Loading boundary has already been consumed"));
    }

    if (this.#pending === 0) {
      state.status = "settled";
      this.#boundaries.delete(state);
      return this.#result(state);
    }

    state.status = "waiting";
    return new Promise<void>((resolve, reject) => {
      this.#completions.set(state, { reject, resolve });
    });
  }

  #settleIdleBoundaries(): void {
    if (this.#pending > 0) {
      return;
    }

    for (const [state, completion] of this.#completions) {
      state.status = "settled";
      this.#boundaries.delete(state);
      this.#completions.delete(state);

      const error = this.#resourceError(state);
      if (error) {
        completion.reject(error);
      } else {
        completion.resolve();
      }
    }
  }

  #result(state: LoadingBoundaryState): Promise<void> {
    const error = this.#resourceError(state);
    return error ? Promise.reject(error) : Promise.resolve();
  }

  #resourceError(state: LoadingBoundaryState): GLTSError | undefined {
    if (state.failures.length === 0) {
      return undefined;
    }

    const failures = state.failures.map((url) => `- ${url}`).join("\n");
    return new GLTSError(
      `Constructor-started resources failed to load:\n${failures}`,
      { url: state.rootURL, phase: "resource" }
    );
  }
}
