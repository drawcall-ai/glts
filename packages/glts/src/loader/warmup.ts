import type { GLTSInstances, GLTSScene, GLTSURL } from "../types.js";
import { waitFor, type Waiter } from "../waits.js";
import type { LoadScope, NestedLoader } from "./scope.js";

/** Internal loader entry point; the browser loader need not retain the build scheduler. */
export const resolveWarmup = Symbol("glts warmup");

/** The scripts' resolved URLs, and how the loader executes a run of one. */
export interface WarmupScripts {
  readonly urls: readonly string[];
  readonly execute: (run: Run) => Promise<GLTSScene>;
}

interface WarmupLoader {
  [resolveWarmup](urls: readonly GLTSURL[]): WarmupScripts;
}

/** Runs all scripts and their dependencies, leaving scene disposal to the loader's owner. */
export function warmup(loader: WarmupLoader, urls: readonly GLTSURL[]): Promise<void> {
  const scripts = loader[resolveWarmup](urls);
  return new Warmup(scripts.execute).run(scripts.urls);
}

const cyclic = "Cyclic GLTS warmup dependency";

/** One execution, distinct from other executions of the same URL, whose session serves its nested loads. */
export class Run implements Waiter, NestedLoader {
  readonly waits = new Set<Waiter>();
  readonly #session: Warmup;
  settled = false;
  readonly promise: Promise<GLTSScene>;

  /** Starts after `previous`, unless `parent` waiting for it would close a cycle. */
  constructor(
    session: Warmup,
    readonly url: string,
    readonly count: number | undefined,
    readonly scope: LoadScope | undefined,
    execute: (run: Run) => Promise<GLTSScene>,
    previous: Run | undefined,
    parent: Run | undefined,
  ) {
    this.#session = session;
    if (previous && !previous.settled) this.waits.add(previous);
    waitFor(parent, this, cyclic);
    this.promise = Promise.resolve().then(async () => {
      try {
        // The previous run's failure belongs to its own consumer.
        if (previous) await Promise.allSettled([previous.promise]);
        this.waits.clear();
        return await execute(this);
      } finally {
        this.settled = true;
        this.waits.clear();
      }
    });
  }

  loadAsync(url: string, scope: LoadScope): Promise<GLTSScene> {
    return this.#session.load(url, undefined, scope, this);
  }

  loadInstancesAsync(url: string, count: number, scope: LoadScope): Promise<GLTSInstances> {
    return this.#session.load(url, count, scope, this);
  }
}

interface Queue {
  /** Only an ordinary nested load can take the initial scene, exactly once. */
  initial: Run | undefined;
  tail: Run;
}

/**
 * Initial scenes run concurrently; subsequent consumers get independent executions, serialized per URL so each
 * finds the asset caches the URL's earlier executions warmed instead of filling them concurrently.
 */
export class Warmup {
  readonly #queues = new Map<string, Queue>();
  readonly #execute: (run: Run) => Promise<GLTSScene>;

  constructor(execute: (run: Run) => Promise<GLTSScene>) {
    this.#execute = execute;
  }

  async run(urls: readonly string[]): Promise<void> {
    // Register every initial run before any script can request another one's scene.
    const initials = [...new Set(urls)].map((url) => {
      const initial = this.#create(url);
      this.#queues.set(url, { initial, tail: initial });
      return initial;
    });
    const results = await Promise.allSettled(initials.map((initial) => initial.promise));
    // A parent that claimed a failed initial scene rejects with the same error.
    const errors = [...new Set(results.flatMap((result) => result.status === "rejected" ? [result.reason] : []))];
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, "GLTS build warmup failed");
  }

  load(url: string, count: undefined, scope: LoadScope, parent: Run): Promise<GLTSScene>;
  load(url: string, count: number, scope: LoadScope, parent: Run): Promise<GLTSInstances>;
  load(url: string, count: number | undefined, scope: LoadScope, parent: Run): Promise<GLTSScene> {
    const queue = this.#queues.get(url);
    const initial = count === undefined ? queue?.initial : undefined;
    let run: Run;
    if (initial && queue) {
      waitFor(parent, initial, cyclic);
      queue.initial = undefined;
      run = initial;
    } else {
      run = this.#create(url, count, scope, queue?.tail, parent);
      this.#queues.set(url, { initial: queue?.initial, tail: run });
    }
    return run.promise;
  }

  #create(url: string, count?: number, scope?: LoadScope, previous?: Run, parent?: Run): Run {
    return new Run(this, url, count, scope, this.#execute, previous, parent);
  }
}
