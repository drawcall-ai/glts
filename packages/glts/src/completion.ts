import type { LoadingManager } from "three";

/**
 * When frames drawing a view show it complete, judged by the items a host's manager starts from construction on.
 * Count every frame with `frame()`, after it rendered; `restart()` when the view changed, such as the camera moving
 * or another scene being drawn. A view is complete once two frames in a row start or end no item while none is
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

  /** Counts the frame just rendered and returns whether the view is complete, after throwing failures as `throwFailures`. */
  frame(): boolean {
    this.throwFailures();
    this.#quiet = this.#changes === this.#counted && this.#open === 0 ? this.#quiet + 1 : 0;
    this.#counted = this.#changes;
    return this.#quiet >= 2;
  }

  /** Gives the manager back the item methods it had at construction, undoing wrappers added since. */
  dispose(): void {
    this.#restore();
  }
}
