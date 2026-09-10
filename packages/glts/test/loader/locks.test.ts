import { expect, it } from "vitest";

import { URLLocks } from "../../src/loader/locks.js";

it("allows concurrent reads and gives a queued writer priority", async () => {
  const locks = new URLLocks();
  const releaseFirst = await locks.acquireRead("a.glts");
  const releaseSecond = await locks.acquireRead("a.glts");
  let releaseWrite: (() => void) | undefined;
  const writing = locks.acquireWrite("a.glts").then((release) => {
    releaseWrite = release;
  });
  const laterRead = locks.acquireRead("a.glts");

  releaseFirst();
  await Promise.resolve();
  expect(releaseWrite).toBeUndefined();
  releaseSecond();
  await writing;

  let readStarted = false;
  void laterRead.then(() => {
    readStarted = true;
  });
  await Promise.resolve();
  expect(readStarted).toBe(false);
  releaseWrite?.();
  const releaseLater = await laterRead;
  releaseLater();
});

it("serializes writes across URLs", async () => {
  const locks = new URLLocks();
  const releaseFirst = await locks.acquireWrite("a.glts");
  let secondStarted = false;
  const second = locks.acquireWrite("b.glts").then((release) => {
    secondStarted = true;
    return release;
  });

  await Promise.resolve();
  expect(secondStarted).toBe(false);
  releaseFirst();
  const releaseSecond = await second;
  expect(secondStarted).toBe(true);
  releaseSecond();
});

it("keeps a host read behind an already queued write", async () => {
  const locks = new URLLocks();
  const releaseFirst = await locks.acquireWrite("a.glts");
  let releaseSecond: (() => void) | undefined;
  const second = locks.acquireWrite("b.glts").then((release) => {
    releaseSecond = release;
  });
  let readStarted = false;
  const read = locks.acquireRead("b.glts").then((release) => {
    readStarted = true;
    return release;
  });

  await Promise.resolve();
  expect(readStarted).toBe(false);
  releaseFirst();
  await second;
  expect(readStarted).toBe(false);
  releaseSecond?.();
  const releaseRead = await read;
  expect(readStarted).toBe(true);
  releaseRead();
});

it("lets a nested read complete before a queued write", async () => {
  const locks = new URLLocks();
  const releaseFirst = await locks.acquireWrite("a.glts");
  let secondStarted = false;
  const second = locks.acquireWrite("b.glts").then((release) => {
    secondStarted = true;
    return release;
  });
  const releaseRead = await locks.acquireReadBeforeQueuedWrite("b.glts");

  releaseFirst();
  await Promise.resolve();
  expect(secondStarted).toBe(false);
  releaseRead();
  const releaseSecond = await second;
  expect(secondStarted).toBe(true);
  releaseSecond();
});

it("keeps queued write state after an earlier nested read ends", async () => {
  const locks = new URLLocks();
  const releaseFirst = await locks.acquireWrite("a.glts");
  let releaseSecond: (() => void) | undefined;
  const second = locks.acquireWrite("b.glts").then((release) => {
    releaseSecond = release;
  });
  const releaseNested = await locks.acquireReadBeforeQueuedWrite("b.glts");
  releaseNested();
  let hostReadStarted = false;
  const hostRead = locks.acquireRead("b.glts").then((release) => {
    hostReadStarted = true;
    return release;
  });

  await Promise.resolve();
  expect(hostReadStarted).toBe(false);
  releaseFirst();
  await second;
  expect(hostReadStarted).toBe(false);
  releaseSecond?.();
  const releaseHostRead = await hostRead;
  expect(hostReadStarted).toBe(true);
  releaseHostRead();
});
