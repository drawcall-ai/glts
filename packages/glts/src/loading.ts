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

function scopedURL(url: string, runtimeKey: string): string {
  // Three.js coalesces requests globally by the raw manager-resolved URL. A
  // removable path segment isolates runtimes without changing the fetched URL.
  const segment = `.__glts_runtime_${encodeURIComponent(runtimeKey)}`;
  const absolute = /^(https?:\/\/[^/?#]+|file:\/\/[^/?#]*)(.*)$/i.exec(url);
  if (absolute) {
    const [, origin, suffix] = absolute;
    if (origin !== undefined && suffix !== undefined) {
      return `${origin}/${segment}/..${suffix}`;
    }
  }

  if (url.startsWith("/")) {
    return `/${segment}/..${url}`;
  }

  const relativePath = !/^[A-Za-z][A-Za-z\d+.-]*:/.test(url)
    && !url.startsWith("?")
    && !url.startsWith("#");
  if (relativePath) {
    return `./${segment}/../${url}`;
  }

  // Opaque URLs do not normalize path segments, but fetch ignores fragments.
  const separator = url.includes("#") ? "&" : "#";
  return `${url}${separator}__glts_runtime=${encodeURIComponent(runtimeKey)}`;
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
  readonly #sourceURLs = new Map<string, string>();
  readonly #urlLoads = new Map<string, number>();
  #pending = 0;

  constructor(runtimeKey: string) {
    const itemStart = this.manager.itemStart.bind(this.manager);
    const itemEnd = this.manager.itemEnd.bind(this.manager);
    const itemError = this.manager.itemError.bind(this.manager);
    const resolveURL = this.manager.resolveURL.bind(this.manager);

    this.manager.resolveURL = (url): string => {
      const sourceURL = resolveURL(url);
      const isolatedURL = scopedURL(sourceURL, runtimeKey);
      this.#sourceURLs.set(isolatedURL, sourceURL);
      return isolatedURL;
    };

    this.manager.itemStart = (url): void => {
      const sourceURL = this.#sourceURL(url);
      if (this.#sourceURLs.has(url)) {
        this.#urlLoads.set(url, (this.#urlLoads.get(url) ?? 0) + 1);
      }
      if (this.#pending === 0) {
        this.#activeFailures.length = 0;
      }
      this.#pending += 1;
      itemStart(sourceURL);
    };
    this.manager.itemError = (url): void => {
      const sourceURL = this.#sourceURL(url);
      this.#activeFailures.push(sourceURL);
      for (const boundary of this.#boundaries) {
        boundary.failures.push(sourceURL);
      }
      itemError(sourceURL);
    };
    this.manager.itemEnd = (url): void => {
      const sourceURL = this.#sourceURL(url);
      if (this.#pending === 0) {
        throw new Error(`Loading manager ended an untracked resource: ${sourceURL}`);
      }

      try {
        itemEnd(sourceURL);
      } finally {
        this.#pending -= 1;
        this.#settleIdleBoundaries();
        if (this.#pending === 0) {
          this.#activeFailures.length = 0;
        }
        this.#releaseURL(url);
      }
    };
  }

  #sourceURL(url: string): string {
    return this.#sourceURLs.get(url) ?? url;
  }

  #releaseURL(url: string): void {
    const loads = this.#urlLoads.get(url);
    if (loads === undefined) {
      return;
    }

    if (loads > 1) {
      this.#urlLoads.set(url, loads - 1);
      return;
    }

    this.#urlLoads.delete(url);
    this.#sourceURLs.delete(url);
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
