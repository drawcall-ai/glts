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

export interface LoadingBoundary {
  cancel(): void;
  waitForIdle(): Promise<void>;
}

export class RuntimeLoading {
  readonly manager = new LoadingManager();
  readonly #boundaries = new Set<LoadingBoundaryState>();
  readonly #completions = new Map<LoadingBoundaryState, LoadingCompletion>();
  #pending = 0;

  constructor() {
    const itemStart = this.manager.itemStart.bind(this.manager);
    const itemEnd = this.manager.itemEnd.bind(this.manager);
    const itemError = this.manager.itemError.bind(this.manager);

    this.manager.itemStart = (url): void => {
      this.#pending += 1;
      itemStart(url);
    };
    this.manager.itemError = (url): void => {
      for (const boundary of this.#boundaries) {
        boundary.failures.push(url);
      }
      itemError(url);
    };
    this.manager.itemEnd = (url): void => {
      if (this.#pending === 0) {
        throw new Error(`Loading manager ended an untracked resource: ${url}`);
      }

      try {
        itemEnd(url);
      } finally {
        this.#pending -= 1;
        this.#settleIdleBoundaries();
      }
    };
  }

  begin(rootURL: string): LoadingBoundary {
    const state: LoadingBoundaryState = {
      failures: [],
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
