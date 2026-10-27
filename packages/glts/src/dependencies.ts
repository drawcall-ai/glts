/**
 * The files one execution, script, or helper was observed to use. A child given as a function is read on
 * each snapshot, so a reloaded nested script contributes its current files.
 */
export class Dependencies {
  readonly #urls = new Set<string>();
  readonly #children = new Set<Dependencies | (() => Dependencies)>();

  add(...urls: string[]): void {
    for (const url of urls) this.#urls.add(url);
  }

  include(child: Dependencies | (() => Dependencies)): void {
    this.#children.add(child);
  }

  /** These URLs and their children's, transitively, sorted. */
  snapshot(): string[] {
    const urls = new Set<string>();
    const visited = new Set<Dependencies>();
    const queue: Dependencies[] = [this];
    for (const dependencies of queue) {
      if (visited.has(dependencies)) continue;
      visited.add(dependencies);
      for (const url of dependencies.#urls) urls.add(url);
      for (const child of dependencies.#children) queue.push(typeof child === "function" ? child() : child);
    }
    return [...urls].sort();
  }
}
