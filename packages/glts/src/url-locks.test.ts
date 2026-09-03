import { expect, it } from "vitest";

import { URLLocks } from "./url-locks.js";

it("allows concurrent reads and gives a queued writer priority", async () => {
  const locks = new URLLocks();
  const releaseFirst = await locks.read("a.glts");
  const releaseSecond = await locks.read("a.glts");
  let releaseWrite: (() => void) | undefined;
  const writing = locks.write("a.glts").then((release) => {
    releaseWrite = release;
  });
  const laterRead = locks.read("a.glts");

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
  const releaseFirst = await locks.write("a.glts");
  let secondStarted = false;
  const second = locks.write("b.glts").then((release) => {
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
  const releaseFirst = await locks.write("a.glts");
  let releaseSecond: (() => void) | undefined;
  const second = locks.write("b.glts").then((release) => {
    releaseSecond = release;
  });
  let readStarted = false;
  const read = locks.read("b.glts").then((release) => {
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
  const releaseFirst = await locks.write("a.glts");
  let secondStarted = false;
  const second = locks.write("b.glts").then((release) => {
    secondStarted = true;
    return release;
  });
  const releaseRead = await locks.readBeforeQueuedWrite("b.glts");

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
  const releaseFirst = await locks.write("a.glts");
  let releaseSecond: (() => void) | undefined;
  const second = locks.write("b.glts").then((release) => {
    releaseSecond = release;
  });
  const releaseNested = await locks.readBeforeQueuedWrite("b.glts");
  releaseNested();
  let hostReadStarted = false;
  const hostRead = locks.read("b.glts").then((release) => {
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
