import type { LoadingManager } from "three";

/**
 * The items `manager` starts from construction on, which include what content streams in after a script's load
 * settled: how many are open, how often one started or ended, and which failed.
 */
export class ItemCount {
  open = 0;
  changes = 0;
  readonly #failed: string[] = [];

  constructor(manager: LoadingManager) {
    const { itemStart, itemEnd, itemError } = manager;
    manager.itemStart = (url) => {
      this.changes += 1;
      this.open += 1;
      itemStart.call(manager, url);
    };
    manager.itemEnd = (url) => {
      this.changes += 1;
      this.open -= 1;
      itemEnd.call(manager, url);
    };
    manager.itemError = (url) => {
      this.#failed.push(url);
      itemError.call(manager, url);
    };
  }

  /** Throws the items that failed so far, whenever they failed. */
  throwFailures(): void {
    if (this.#failed.length > 0) throw new Error(`Items failed to load:\n${this.#failed.map((item) => `- ${item}`).join("\n")}`);
  }
}
