import { withoutQuery } from "../urls.js";
import type { Importer } from "./index.js";

/** Retains failed and historical imports so edits still invalidate every affected script and query variant. */
export class ImportHistory {
  readonly #requests = new Set<string>();
  readonly #scripts = new Map<string, Set<string>>();
  readonly #helpers = new Map<string, Set<string>>();

  request(url: string): void {
    this.#requests.add(url);
  }

  /** Records both fetched redirects and imports, including helpers whose fetch has not finished. */
  add(importer: Importer, url: string): void {
    const history = importer.kind === "script" ? this.#scripts : this.#helpers;
    const urls = history.get(importer.key) ?? new Set<string>();
    history.set(importer.key, urls);
    urls.add(url);
  }

  affected(url: string, linkedHelpers: Iterable<string>): { helpers: string[]; scripts: string[]; requests: string[] } {
    const helpers = [...linkedHelpers].filter((helper) => this.#uses([helper], url));
    const scripts = [...new Set([...this.#requests].map(withoutQuery))].filter((script) =>
      this.#uses([script, ...this.#scripts.get(script) ?? []], url));
    const files = new Set(scripts);
    const requests = [...this.#requests].filter((request) => files.has(withoutQuery(request)));
    return { helpers, scripts, requests };
  }

  #uses(urls: Iterable<string>, url: string): boolean {
    const file = withoutQuery(url);
    const pending = [...urls];
    const visited = new Set<string>();
    for (const next of pending) {
      if (withoutQuery(next) === file) return true;
      if (visited.has(next)) continue;
      visited.add(next);
      pending.push(...this.#helpers.get(next) ?? []);
    }
    return false;
  }
}
