import { describe, expect, it } from "vitest";

import { GLTSError } from "./errors.js";
import { RuntimeLoading } from "./loading.js";

describe("RuntimeLoading", () => {
  it("waits for every tracked resource to finish", async () => {
    const loading = new RuntimeLoading();
    const boundary = loading.begin("https://example.test/tree.glts");
    loading.manager.itemStart("https://example.test/bark.png");
    loading.manager.itemStart("https://example.test/leaves.png");

    let settled = false;
    const completion = boundary.waitForIdle().then(() => {
      settled = true;
    });
    loading.manager.itemEnd("https://example.test/bark.png");
    await Promise.resolve();
    expect(settled).toBe(false);

    loading.manager.itemEnd("https://example.test/leaves.png");
    await completion;
    expect(settled).toBe(true);
  });

  it("rejects at idle when a tracked resource failed", async () => {
    const loading = new RuntimeLoading();
    const boundary = loading.begin("https://example.test/tree.glts");
    const resourceURL = "https://example.test/missing.png";
    loading.manager.itemStart(resourceURL);
    loading.manager.itemError(resourceURL);
    const completion = boundary.waitForIdle();
    loading.manager.itemEnd(resourceURL);

    await expect(completion).rejects.toMatchObject({
      phase: "resource",
      url: "https://example.test/tree.glts"
    });
    await expect(completion).rejects.toThrow(resourceURL);
  });

  it("retains synchronous failures until construction finishes", async () => {
    const loading = new RuntimeLoading();
    const boundary = loading.begin("https://example.test/tree.glts");
    const resourceURL = "https://example.test/missing.png";
    loading.manager.itemStart(resourceURL);
    loading.manager.itemError(resourceURL);
    loading.manager.itemEnd(resourceURL);

    await expect(boundary.waitForIdle()).rejects.toBeInstanceOf(GLTSError);
  });

  it("shares an active failure with boundaries that join before idle", async () => {
    const loading = new RuntimeLoading();
    const resourceURL = "https://example.test/missing.png";
    const first = loading.begin("https://example.test/first.glts");
    loading.manager.itemStart(resourceURL);
    loading.manager.itemError(resourceURL);
    const second = loading.begin("https://example.test/second.glts");
    const firstCompletion = first.waitForIdle();
    const secondCompletion = second.waitForIdle();

    loading.manager.itemEnd(resourceURL);

    await expect(firstCompletion).rejects.toThrow(resourceURL);
    await expect(secondCompletion).rejects.toThrow(resourceURL);
    await expect(
      loading.begin("https://example.test/next.glts").waitForIdle()
    ).resolves.toBeUndefined();
  });

  it("keeps separate runtimes independent", async () => {
    const first = new RuntimeLoading();
    const second = new RuntimeLoading();
    const firstBoundary = first.begin("https://example.test/first.glts");
    const secondBoundary = second.begin("https://example.test/second.glts");
    first.manager.itemStart("https://example.test/slow.png");

    await expect(secondBoundary.waitForIdle()).resolves.toBeUndefined();

    const firstCompletion = firstBoundary.waitForIdle();
    first.manager.itemEnd("https://example.test/slow.png");
    await expect(firstCompletion).resolves.toBeUndefined();
  });
});
