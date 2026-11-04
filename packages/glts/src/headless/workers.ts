import { Worker as Thread } from "node:worker_threads";

/**
 * The thread's code: a dedicated worker's global scope around the module at `workerData.url`. Kept as source, which
 * neither compilers nor test transforms rewrite, since it runs in a realm of its own.
 */
const workerScope = `(async () => {
  const { parentPort: port, workerData } = process.getBuiltinModule("node:worker_threads");
  const events = new EventTarget();
  let onmessage = null;
  // Workers recognize their scope with globalThis instanceof WorkerGlobalScope.
  function WorkerGlobalScope() {}
  WorkerGlobalScope.prototype = Object.getPrototypeOf(globalThis);
  Object.defineProperties(globalThis, {
    self: { value: globalThis },
    WorkerGlobalScope: { value: WorkerGlobalScope },
    postMessage: { value: (message, options = []) => port.postMessage(message, Array.isArray(options) ? options : options.transfer ?? []) },
    close: { value: () => port.close() },
    addEventListener: { value: events.addEventListener.bind(events) },
    removeEventListener: { value: events.removeEventListener.bind(events) },
    dispatchEvent: { value: events.dispatchEvent.bind(events) },
    onmessage: { get: () => onmessage, set: (handler) => { onmessage = handler; } },
  });
  await import(workerData.url);
  // The port queues messages until it has a listener, so none arrives before the module has run, as in browsers.
  port.on("message", (data) => {
    const event = new MessageEvent("message", { data });
    onmessage?.(event);
    events.dispatchEvent(event);
  });
})()`;

/**
 * A browser module worker running in a Node thread; the module must be a file. Unlike a browser's, an error the worker
 * throws ends its thread after the error event, and later messages go nowhere.
 */
class ModuleWorker extends EventTarget {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  readonly #thread: Thread;
  readonly #threads: Set<Thread>;

  constructor(url: string | URL, threads: Set<Thread>) {
    super();
    const module = new URL(url);
    if (module.protocol !== "file:") throw new Error(`Headless module workers run only file: modules, not ${module.href}`);
    this.#thread = new Thread(workerScope, { eval: true, workerData: { url: module.href } });
    this.#threads = threads;
    threads.add(this.#thread);
    this.#thread.on("exit", () => threads.delete(this.#thread));
    this.#thread.on("message", (data: unknown) => this.#dispatch(new MessageEvent("message", { data }), this.onmessage));
    this.#thread.on("messageerror", (data: unknown) => this.#dispatch(new MessageEvent("messageerror", { data }), this.onmessageerror));
    this.#thread.on("error", (error: Error) => {
      // Node has no ErrorEvent; workers read the message as from one. Browsers report errors nobody handles.
      const event = Object.assign(new Event("error", { cancelable: true }), { error, message: error.message });
      this.#dispatch(event, this.onerror);
      if (!event.defaultPrevented) console.error(error);
    });
  }

  postMessage(message: unknown, options: readonly Transferable[] | StructuredSerializeOptions = []): void {
    // Node's transfer list takes ArrayBuffers and ports, as the browser's does for the messages workers exchange.
    const transfer = Array.isArray(options) ? options : "transfer" in options ? options.transfer ?? [] : [];
    this.#thread.postMessage(message, transfer);
  }

  terminate(): void {
    void this.#thread.terminate();
    this.#threads.delete(this.#thread);
  }

  #dispatch<T extends Event>(event: T, handler: ((event: T) => void) | null): void {
    handler?.call(this, event);
    this.dispatchEvent(event);
  }
}

/**
 * A `Worker` constructor that runs module workers in Node threads and leaves classic ones to `classic`, the headless
 * canvas's. `dispose` terminates the module workers still running.
 */
export function moduleWorkers(classic: unknown): { Worker: unknown; dispose: () => Promise<void> } {
  if (typeof classic !== "function") throw new Error("The headless canvas did not install Worker");
  const Classic = classic;
  const threads = new Set<Thread>();
  function Worker(url: string | URL, options?: WorkerOptions): object {
    if (options?.type === "module") return new ModuleWorker(url, threads);
    return Reflect.construct(Classic, [url, options]);
  }
  return {
    Worker,
    dispose: async () => { await Promise.all([...threads].map((thread) => thread.terminate())); },
  };
}
