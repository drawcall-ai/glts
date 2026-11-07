import { runAll } from "../errors.js";

/**
 * Defines `values` as globals, and writable globals whose `getters` make their values when read; the returned function
 * restores what they replaced.
 */
export function setGlobals(values: Readonly<Record<string, unknown>>, getters: Readonly<Record<string, () => unknown>> = {}): () => void {
  const previous = [...Object.keys(values), ...Object.keys(getters)].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  for (const [key, value] of Object.entries(values)) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  for (const [key, get] of Object.entries(getters)) {
    const set = (value: unknown): void => { Object.defineProperty(globalThis, key, { configurable: true, writable: true, value }); };
    Object.defineProperty(globalThis, key, { configurable: true, get, set });
  }
  return () => runAll("Headless globals restoration failed", previous.map(([key, descriptor]) => () => {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else if (!Reflect.deleteProperty(globalThis, key)) throw new Error(`Unable to restore headless global ${key}`);
  }));
}
