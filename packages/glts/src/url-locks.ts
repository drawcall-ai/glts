type Release = () => void;

interface LockState {
  readers: number;
  readersIdle: (() => void) | undefined;
  writer: Promise<void> | undefined;
  writers: number;
  writersIdle: Promise<void> | undefined;
  resolveWritersIdle: (() => void) | undefined;
}

export class URLLocks {
  readonly #states = new Map<string, LockState>();
  readonly #writeQueue: Array<() => void> = [];
  #writeActive = false;

  async read(url: string): Promise<Release> {
    return this.#read(url, false);
  }

  async readBeforeQueuedWrite(url: string): Promise<Release> {
    return this.#read(url, true);
  }

  async #read(url: string, beforeQueuedWrite: boolean): Promise<Release> {
    let state = this.#state(url);
    while (state.writer || (!beforeQueuedWrite && state.writersIdle)) {
      await (state.writer ?? state.writersIdle);
      state = this.#state(url);
    }

    state.readers += 1;
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      state.readers -= 1;
      if (state.readers === 0) {
        state.readersIdle?.();
        state.readersIdle = undefined;
        if (!state.writer && state.writers === 0) {
          this.#states.delete(url);
        }
      }
    };
  }

  write(url: string): Promise<Release> {
    const state = this.#state(url);
    state.writers += 1;
    if (!state.writersIdle) {
      state.writersIdle = new Promise<void>((resolve) => {
        state.resolveWritersIdle = resolve;
      });
    }

    return new Promise((resolve) => {
      const start = (): void => this.#startWrite(url, state, resolve);
      if (this.#writeActive) {
        this.#writeQueue.push(start);
        return;
      }

      this.#writeActive = true;
      start();
    });
  }

  #startWrite(
    url: string,
    state: LockState,
    resolve: (release: Release) => void
  ): void {
    let releaseWriter = (): void => undefined;
    state.writer = new Promise<void>((resolve) => {
      releaseWriter = resolve;
    });
    const grant = (): void => {
      let released = false;
      resolve(() => {
        if (released) {
          return;
        }
        released = true;
        state.writer = undefined;
        releaseWriter();
        state.writers -= 1;
        if (state.writers === 0) {
          state.resolveWritersIdle?.();
          state.resolveWritersIdle = undefined;
          state.writersIdle = undefined;
        }
        if (state.readers === 0 && state.writers === 0) {
          this.#states.delete(url);
        }
        const next = this.#writeQueue.shift();
        if (next) {
          next();
        } else {
          this.#writeActive = false;
        }
      });
    };
    if (state.readers === 0) {
      grant();
    } else {
      state.readersIdle = grant;
    }
  }

  #state(url: string): LockState {
    const existing = this.#states.get(url);
    if (existing) {
      return existing;
    }

    const state: LockState = {
      readers: 0,
      readersIdle: undefined,
      resolveWritersIdle: undefined,
      writer: undefined,
      writers: 0,
      writersIdle: undefined
    };
    this.#states.set(url, state);
    return state;
  }
}
