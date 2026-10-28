import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { inspect } from "node:util";
import { afterAll, expect, it } from "vitest";

import { withHeadless } from "../src/headless/index.js";

const directory = await mkdtemp(join(tmpdir(), "glts-headless-"));
const baseURL = pathToFileURL(`${directory}/`);
const options = { projectURL: baseURL, baseURL, size: 1, loader: {} };
const descriptors = () => ["fetch", "document", "self", "createImageBitmap", "Worker"].map((key) => Object.getOwnPropertyDescriptor(globalThis, key));

afterAll(() => rm(directory, { recursive: true, force: true }));

it("restores the host after setup failure and preserves operation and disposal failures", async () => {
  const before = descriptors();
  await expect(withHeadless({ ...options, size: 0 }, async () => undefined)).rejects.toThrow("Canvas dimensions");
  expect(descriptors()).toEqual(before);

  const file = join(directory, "cleanup.glts");
  await writeFile(file, `import { onDispose } from "@drawcall/glts"; onDispose(() => { throw new Error("scene cleanup failed"); });`);
  const failed = withHeadless(options, async (loader, canvas) => {
    await loader.loadAsync(pathToFileURL(file));
    const dispose = canvas.dispose;
    canvas.dispose = async () => { await dispose(); throw new Error("host cleanup failed"); };
    throw new Error("encoding failed");
  });
  await expect(failed).rejects.toSatisfy((error: unknown) => {
    const details = inspect(error, { depth: null });
    return ["encoding failed", "scene cleanup failed", "host cleanup failed"].every((message) => details.includes(message));
  });
  expect(descriptors()).toEqual(before);
  await expect(withHeadless(options, async () => "next session")).resolves.toBe("next session");
  expect(descriptors()).toEqual(before);
});

it("rejects overlapping and nested sessions without disturbing the active one", async () => {
  const before = descriptors();
  const order: string[] = [];
  let finishFirst: () => void = () => { throw new Error("First session has not started"); };
  let startedFirst: () => void = () => { throw new Error("First session signal has not initialized"); };
  const started = new Promise<void>((resolve) => { startedFirst = resolve; });
  const first = withHeadless(options, async () => {
    order.push("first");
    await expect(withHeadless(options, async () => undefined)).rejects.toThrow("already active");
    startedFirst();
    await new Promise<void>((resolve) => { finishFirst = resolve; });
    order.push("first done");
  });
  await started;
  await expect(withHeadless(options, async () => undefined)).rejects.toThrow("already active");
  expect(order).toEqual(["first"]);
  finishFirst();
  await first;
  await withHeadless(options, async () => { order.push("second"); });
  expect(order).toEqual(["first", "first done", "second"]);
  expect(descriptors()).toEqual(before);
});
