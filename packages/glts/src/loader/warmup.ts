import { GLTSError } from "../errors.js";
import type { GLTSInstances, GLTSScene, GLTSURL } from "../types.js";
import type { LoadScope } from "./scope.js";

/** Internal loader entry point; the browser loader need not retain the build scheduler. */
export const runWarmup = Symbol("glts warmup");

interface WarmupLoader {
  [runWarmup](session: Warmup, urls: readonly GLTSURL[]): Promise<void>;
}

/** Runs all scripts and their dependencies, leaving scene disposal to the loader's owner. */
export function warmup(loader: WarmupLoader, urls: readonly GLTSURL[]): Promise<void> {
  return loader[runWarmup](new Warmup(), urls);
}

/** One execution, distinct from other executions of the same URL. */
export interface Run {
  readonly session: Warmup;
  readonly url: string;
  readonly count: number | undefined;
  readonly scope: LoadScope | undefined;
  readonly waits: Set<Run>;
  readonly promise: Promise<GLTSScene>;
  settled: boolean;
}

interface Queue {
  /** Only an ordinary nested load can take the initial scene, exactly once. */
  initial: Run | undefined;
  tail: Run;
}

/** Initial scenes run concurrently; subsequent consumers get serialized, independent executions. */
export class Warmup {
  readonly #queues = new Map<string, Queue>();
  #execute: ((run: Run) => Promise<GLTSScene>) | undefined;

  async run(urls: readonly string[], execute: (run: Run) => Promise<GLTSScene>): Promise<void> {
    this.#execute = execute;
    // Register every initial run before any script can request another one's scene.
    for (const url of new Set(urls)) {
      const initial = this.#create(url);
      this.#queues.set(url, { initial, tail: initial });
    }
    const results = await Promise.allSettled([...this.#queues.values()].map(({ tail }) => tail.promise));
    const errors = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, "GLTS build warmup failed");
  }

  load(url: string, count: undefined, scope: LoadScope, parent: Run): Promise<GLTSScene>;
  load(url: string, count: number, scope: LoadScope, parent: Run): Promise<GLTSInstances>;
  load(url: string, count: number | undefined, scope: LoadScope, parent: Run): Promise<GLTSScene> {
    const queue = this.#queues.get(url);
    const initial = count === undefined ? queue?.initial : undefined;
    const waiting = initial ?? queue?.tail;
    if (waiting) this.#assertAcyclic(parent, waiting);
    const run = initial ?? this.#create(url, count, scope, queue?.tail);
    if (initial && queue) queue.initial = undefined;
    else this.#queues.set(url, { initial: queue?.initial, tail: run });
    if (!run.settled) parent.waits.add(run);
    return run.promise.finally(() => parent.waits.delete(run));
  }

  #create(url: string, count?: number, scope?: LoadScope, previous?: Run): Run {
    const execute = this.#execute;
    if (!execute) throw new Error("GLTS warmup has not started");
    const run: Run = {
      session: this, url, count, scope, waits: new Set(previous && !previous.settled ? [previous] : []), settled: false,
      promise: Promise.resolve().then(async () => {
        try {
          if (previous) await previous.promise;
          run.waits.clear();
          return await execute(run);
        } finally {
          run.settled = true;
          run.waits.clear();
        }
      }),
    };
    return run;
  }

  #assertAcyclic(parent: Run, child: Run): void {
    if (child.settled) return;
    const pending = [{ run: child, path: [child.url] }];
    const visited = new Set<Run>();
    for (const { run, path } of pending) {
      if (run === parent) {
        throw new GLTSError("Cyclic GLTS warmup dependency", {
          phase: "resolve", url: child.url, importChain: [parent.url, ...path],
        });
      }
      if (visited.has(run)) continue;
      visited.add(run);
      pending.push(...[...run.waits].map((next) => ({ run: next, path: [...path, next.url] })));
    }
  }
}
