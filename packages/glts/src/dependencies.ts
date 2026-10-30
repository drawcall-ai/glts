/**
 * The files one execution, script, or helper was observed to use. A child given as a function is read on
 * each read, so a reloaded nested script contributes its current files. Provenance that cannot be stated loads anyway
 * and fails where it is read: an unknown origin where packages or module hashes are read, two hashes for one module
 * where module hashes are read.
 */
export class Dependencies {
  readonly #urls = new Set<string>();
  readonly #packages = new Set<string>();
  readonly #modules = new Map<string, Set<string>>();
  readonly #runtimeModules = new Set<string>();
  readonly #unknown: Error[] = [];
  readonly #children = new Set<Dependencies | (() => Dependencies)>();

  add(...urls: string[]): void {
    for (const url of urls) this.#urls.add(url);
  }

  addPackage(name: string): void {
    this.#packages.add(name);
  }

  addModule(url: string, hash: string, origin: "bundled" | "runtime"): void {
    if (origin === "runtime") this.#runtimeModules.add(url);
    const hashes = this.#modules.get(url) ?? new Set<string>();
    hashes.add(hash);
    this.#modules.set(url, hashes);
  }

  /** Records a module whose origin cannot be stated; reading packages or module hashes then throws `error`. */
  addUnknown(error: Error): void {
    this.#unknown.push(error);
  }

  runtimeModules(): string[] {
    return this.#snapshot((dependencies) => dependencies.#runtimeModules);
  }

  /** Remote module source hashes, separate from locally installed package versions; throws if one URL has two hashes. */
  moduleHashes(): Readonly<Record<string, string>> {
    this.#throwUnknown();
    const modules = new Map<string, string>();
    for (const dependencies of this.#all()) {
      for (const [url, hashes] of dependencies.#modules) {
        for (const hash of hashes) setModule(modules, url, hash);
      }
    }
    return Object.fromEntries([...modules].sort(([a], [b]) => a.localeCompare(b)));
  }

  include(child: Dependencies | (() => Dependencies)): void {
    this.#children.add(child);
  }

  /** These URLs and their children's, transitively, sorted. */
  urls(): string[] {
    return this.#snapshot((dependencies) => dependencies.#urls);
  }

  /** Imported package names, including nested executions and helpers, sorted. */
  packages(): string[] {
    this.#throwUnknown();
    return this.#snapshot((dependencies) => dependencies.#packages);
  }

  #throwUnknown(): void {
    for (const dependencies of this.#all()) {
      const [error] = dependencies.#unknown;
      if (error) throw error;
    }
  }

  #snapshot(values: (dependencies: Dependencies) => Iterable<string>): string[] {
    const entries = new Set<string>();
    for (const dependencies of this.#all()) {
      for (const value of values(dependencies)) entries.add(value);
    }
    return [...entries].sort();
  }

  *#all(): Generator<Dependencies> {
    const visited = new Set<Dependencies>();
    const queue: Dependencies[] = [this];
    for (const dependencies of queue) {
      if (visited.has(dependencies)) continue;
      visited.add(dependencies);
      yield dependencies;
      for (const child of dependencies.#children) queue.push(typeof child === "function" ? child() : child);
    }
  }
}

function setModule(modules: Map<string, string>, url: string, hash: string): void {
  const previous = modules.get(url);
  if (previous !== undefined && previous !== hash) throw new Error(`Conflicting module content hashes for ${url}`);
  modules.set(url, hash);
}
