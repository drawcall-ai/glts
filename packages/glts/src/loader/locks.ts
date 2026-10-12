type Release = () => void;

interface Write {
  readonly url: string;
}

/**
 * Read/write locks per URL. Writes run one at a time in request order across all URLs, each
 * waiting for its URL's reads to end; a read of a URL waits while a write of it is queued.
 */
export class URLLocks {
  /** One entry per held read. */
  readonly #reads: string[] = [];
  /** The head is the write that holds the lock or waits for reads to end. */
  readonly #writes: Write[] = [];
  #waiting: Array<() => void> = [];

  acquireRead(url: string): Promise<Release> {
    return this.#read(url, () => this.#writes.every((write) => write.url !== url));
  }

  /** For a load nested in a running load: passes queued writes, but not the head write. */
  acquireReadBeforeQueuedWrite(url: string): Promise<Release> {
    return this.#read(url, () => this.#writes[0]?.url !== url);
  }

  async acquireWrite(url: string): Promise<Release> {
    const write = { url };
    this.#writes.push(write);
    await this.#until(() => this.#writes[0] === write && !this.#reads.includes(url));
    return this.#release(() => this.#writes.shift());
  }

  async #read(url: string, ready: () => boolean): Promise<Release> {
    // Taken in the step that finds the lock free, so a write requested meanwhile sees it.
    await this.#until(ready, () => this.#reads.push(url));
    return this.#release(() => this.#reads.splice(this.#reads.indexOf(url), 1));
  }

  async #until(ready: () => boolean, take?: () => void): Promise<void> {
    while (!ready()) {
      await new Promise<void>((resolve) => this.#waiting.push(resolve));
    }
    take?.();
  }

  /** Every release wakes all waiters to recheck their condition. */
  #release(release: () => void): Release {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      release();
      const waiting = this.#waiting;
      this.#waiting = [];
      for (const wake of waiting) wake();
    };
  }
}
