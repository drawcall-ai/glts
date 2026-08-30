import { LoadingManager } from "three";

import { GLTSError } from "./errors.js";

interface LoadingBoundaryState {
  cancellation?: { readonly reason: unknown };
  readonly failures: string[];
  readonly rootURL: string;
  completion?: LoadingCompletion;
}

interface LoadingCompletion {
  readonly reject: (error: unknown) => void;
  readonly resolve: () => void;
}

export interface LoadingBoundary {
  cancel(reason?: unknown): void;
  waitForIdle(): Promise<void>;
}

export class RuntimeLoading {
  readonly manager = new LoadingManager();
  readonly #boundaries = new Set<LoadingBoundaryState>();
  readonly #activeFailures: string[] = [];
  #pending = 0;

  constructor() {
    const itemStart = this.manager.itemStart.bind(this.manager);
    const itemEnd = this.manager.itemEnd.bind(this.manager);
    const itemError = this.manager.itemError.bind(this.manager);

    this.manager.itemStart = (url): void => {
      if (this.#pending === 0) {
        this.#activeFailures.length = 0;
      }
      this.#pending += 1;
      itemStart(url);
    };
    this.manager.itemError = (url): void => {
      this.#activeFailures.push(url);
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
        if (this.#pending === 0) {
          this.#activeFailures.length = 0;
        }
      }
    };
  }

  begin(rootURL: string): LoadingBoundary {
    const state: LoadingBoundaryState = {
      failures: this.#pending > 0 ? [...this.#activeFailures] : [],
      rootURL
    };
    this.#boundaries.add(state);
    let consumed = false;

    return {
      cancel: (reason) => {
        if (!this.#boundaries.delete(state)) {
          return;
        }

        state.cancellation = {
          reason: reason ?? new Error("Loading boundary was cancelled")
        };
        state.completion?.reject(state.cancellation.reason);
        delete state.completion;
      },
      waitForIdle: () => {
        if (consumed) {
          return Promise.reject(new Error("Loading boundary has already been consumed"));
        }
        consumed = true;

        // Coalesced roots construct in adjacent promise reactions.
        return Promise.resolve().then(() => this.#waitForIdle(state));
      }
    };
  }

  #waitForIdle(state: LoadingBoundaryState): Promise<void> {
    if (state.cancellation) {
      return Promise.reject(state.cancellation.reason);
    }

    if (this.#pending === 0) {
      this.#boundaries.delete(state);
      const error = this.#resourceError(state);
      return error ? Promise.reject(error) : Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
      state.completion = { reject, resolve };
    });
  }

  #settleIdleBoundaries(): void {
    if (this.#pending > 0) {
      return;
    }

    for (const state of this.#boundaries) {
      const completion = state.completion;
      if (!completion) {
        continue;
      }

      this.#boundaries.delete(state);
      delete state.completion;

      const error = this.#resourceError(state);
      if (error) {
        completion.reject(error);
      } else {
        completion.resolve();
      }
    }
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
