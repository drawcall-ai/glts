import type { LoadingManager } from "three";

/**
 * When frames drawing a view show it complete, judged by the items a host's manager starts from construction on.
 * Count every frame with `frame()`, after it rendered; `restart()` when the view changed, such as the camera moving
 * or another scene being drawn; or `await settled()`, counting frames meanwhile. A view is complete once two frames in a row start or end no item while none is
 * open. Two, since changes made during a render, after the affected object was drawn, reach the GPU only at the next
 * frame's render. Keep rendering frames until then: content that streams in per view starts its items as frames draw.
 * Construct it before the manager starts any item. It wraps the manager's item methods; `dispose()` puts back those it
 * found, so dispose wrappers added after it first.
 */
export class ViewCompletion {
  readonly #restore: () => void;
  #open = 0;
  readonly #failed: string[] = [];
  #changes = 0;
  #counted = 0;
  #quiet = 0;
  #waits: { resolve(): void; reject(error: unknown): void }[] = [];

  constructor(manager: LoadingManager) {
    const { itemStart, itemEnd, itemError } = manager;
    this.#restore = () => Object.assign(manager, { itemStart, itemEnd, itemError });
    manager.itemStart = (url) => {
      this.#changes += 1;
      this.#open += 1;
      itemStart.call(manager, url);
    };
    manager.itemEnd = (url) => {
      itemEnd.call(manager, url);
      // An item that started before construction ended: views counted while it was loading looked complete.
      if (this.#open === 0) {
        this.#failed.push(`${url} (ended without starting since the ViewCompletion was constructed)`);
        return;
      }
      this.#changes += 1;
      this.#open -= 1;
    };
    manager.itemError = (url) => {
      this.#failed.push(url);
      itemError.call(manager, url);
    };
  }

  /** The number of items open now. */
  get open(): number {
    return this.#open;
  }

  /** Starts counting frames anew, for a view that changed since the last frame was counted. */
  restart(): void {
    this.#counted = this.#changes;
    this.#quiet = 0;
  }

  /** Throws the items that failed since the last throw, whenever they failed, and forgets them, so a host can carry on. */
  throwFailures(): void {
    const failed = this.#failed.splice(0);
    if (failed.length > 0) throw new Error(`Items failed to load:\n${failed.map((item) => `- ${item}`).join("\n")}`);
  }

  /** Whether a `settled()` waits for frames to be counted. */
  get waiting(): boolean {
    return this.#waits.length > 0;
  }

  /**
   * Restarts, and resolves once `frame()` finds the view complete, or rejects with the failures it finds first, which
   * include those since the last throw. After the view changed, ask again.
   */
  settled(): Promise<void> {
    this.restart();
    return new Promise((resolve, reject) => this.#waits.push({ resolve, reject }));
  }

  /**
   * Counts the frame just rendered and returns whether the view is complete, after throwing failures as `throwFailures`:
   * to the `settled()` that wait, if any, instead.
   */
  frame(): boolean {
    try {
      this.throwFailures();
    } catch (error) {
      if (!this.waiting) throw error;
      for (const wait of this.#waits.splice(0)) wait.reject(error);
      return false;
    }
    this.#quiet = this.#changes === this.#counted && this.#open === 0 ? this.#quiet + 1 : 0;
    this.#counted = this.#changes;
    if (this.#quiet < 2) return false;
    for (const wait of this.#waits.splice(0)) wait.resolve();
    return true;
  }

  /** Gives the manager back the item methods it had at construction, undoing wrappers added since. */
  dispose(): void {
    this.#restore();
  }
}
