import { runAll } from "../errors.js";

/** Defines `values` as globals; the returned function restores what they replaced. */
export function setGlobals(values: Readonly<Record<string, unknown>>): () => void {
  const previous = Object.keys(values).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  for (const [key, value] of Object.entries(values)) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  return () => runAll("Headless globals restoration failed", previous.map(([key, descriptor]) => () => {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else if (!Reflect.deleteProperty(globalThis, key)) throw new Error(`Unable to restore headless global ${key}`);
  }));
}
