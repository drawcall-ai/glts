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

interface RunOptions {
  readonly count?: number | undefined;
  readonly scope?: LoadScope | undefined;
  readonly previous?: Run | undefined;
  readonly parent?: Run | undefined;
  readonly start?: Promise<void> | undefined;
}

/** One execution, distinct from other executions of the same URL, whose session serves its nested loads. */
export class Run implements Waiter, NestedLoader {
  readonly waits = new Set<Waiter>();
  readonly #session: Warmup;
  settled = false;
  readonly count: number | undefined;
  readonly scope: LoadScope | undefined;
  readonly promise: Promise<GLTSScene>;

  /** Starts after `previous` and `start`, unless `parent` waiting for it would close a cycle. */
  constructor(
    session: Warmup,
    readonly url: string,
    execute: (run: Run) => Promise<GLTSScene>,
    { count, scope, previous, parent, start = Promise.resolve() }: RunOptions,
  ) {
    this.#session = session;
    this.count = count;
    this.scope = scope;
    if (previous && !previous.settled) this.waits.add(previous);
    waitFor(parent, this, cyclic);
    this.promise = start.then(async () => {
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
  /** Starts the initial scene, which waits for its turn or for a script to load it; nothing for a URL without one. */
  begin: () => void;
  tail: Run;
}

/**
 * Initial scenes run one after another, so each finds the asset caches the earlier ones warmed instead of filling
 * them again concurrently; a script loading another's initial scene starts it early. Subsequent consumers get
 * independent executions, serialized per URL for the same reason.
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
      // Not Promise.withResolvers, which GLTS's ES2022 target and the script checks' lib lack.
      let begin = (): void => {};
      const start = new Promise<void>((resolve) => { begin = resolve; });
      const initial = this.#create(url, { start });
      this.#queues.set(url, { initial, begin, tail: initial });
      return { initial, begin };
    });
    // A parent that claimed a failed initial scene rejects with the same error.
    const errors = new Set<unknown>();
    for (const { initial, begin } of initials) {
      begin();
      try { await initial.promise; }
      catch (error) { errors.add(error); }
    }
    if (errors.size === 1) throw [...errors][0];
    if (errors.size > 1) throw new AggregateError([...errors], "GLTS build warmup failed");
  }

  load(url: string, count: undefined, scope: LoadScope, parent: Run): Promise<GLTSScene>;
  load(url: string, count: number, scope: LoadScope, parent: Run): Promise<GLTSInstances>;
  load(url: string, count: number | undefined, scope: LoadScope, parent: Run): Promise<GLTSScene> {
    const queue = this.#queues.get(url);
    const initial = count === undefined ? queue?.initial : undefined;
    // Whether it takes the initial scene or queues behind it, a load cannot wait for the initial scene's turn.
    queue?.begin();
    let run: Run;
    if (initial && queue) {
      waitFor(parent, initial, cyclic);
      queue.initial = undefined;
      run = initial;
    } else {
      run = this.#create(url, { count, scope, previous: queue?.tail, parent });
      if (queue) queue.tail = run;
      else this.#queues.set(url, { initial: undefined, begin: () => {}, tail: run });
    }
    return run.promise;
  }

  #create(url: string, options: RunOptions): Run {
    return new Run(this, url, this.#execute, options);
  }
}
