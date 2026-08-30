export function deferred() {
  let resolve = (): void => {
    throw new Error("Deferred promise was not initialized");
  };
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
