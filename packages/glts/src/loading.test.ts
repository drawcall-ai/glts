import { FileLoader, LoadingManager } from "three";
import { describe, expect, it, vi } from "vitest";

import { LoadingScope } from "./loading.js";

describe("LoadingScope", () => {
  it("waits only for resources started through its manager", async () => {
    const host = new LoadingManager();
    const first = new LoadingScope(host, "first.glts");
    const second = new LoadingScope(host, "second.glts");
    first.manager.itemStart("slow.bin");

    let firstSettled = false;
    const firstCompletion = first.waitForIdle().then(() => {
      firstSettled = true;
    });
    await expect(second.waitForIdle()).resolves.toBeUndefined();
    expect(firstSettled).toBe(false);

    first.manager.itemEnd("slow.bin");
    await firstCompletion;
  });

  it("isolates a resource failure from other scopes", async () => {
    const host = new LoadingManager();
    const successful = new LoadingScope(host, "successful.glts");
    const failed = new LoadingScope(host, "failed.glts");
    failed.manager.itemStart("missing.bin");
    failed.manager.itemError("missing.bin");
    failed.manager.itemEnd("missing.bin");

    await expect(successful.waitForIdle()).resolves.toBeUndefined();
    await expect(failed.waitForIdle()).rejects.toMatchObject({
      phase: "resource",
      url: "failed.glts"
    });
  });

  it("balances host notifications when callbacks throw", async () => {
    const onProgress = vi.fn(() => {
      throw new Error("progress failed");
    });
    const host = new LoadingManager(undefined, onProgress);
    const scope = new LoadingScope(host, "tree.glts");
    scope.manager.itemStart("leaf.png");
    scope.manager.itemEnd("leaf.png");

    await expect(scope.waitForIdle()).rejects.toMatchObject({
      phase: "resource",
      url: "tree.glts"
    });
    expect(onProgress).toHaveBeenCalledOnce();
  });

  it("rejects pending completion when cancelled", async () => {
    const scope = new LoadingScope(new LoadingManager(), "tree.glts");
    scope.manager.itemStart("slow.bin");
    const completion = scope.waitForIdle();
    await Promise.resolve();
    scope.cancel(new Error("cancelled"));

    await expect(completion).rejects.toThrow("cancelled");
  });

  it("rejects host-bound handlers and accepts scoped handlers", () => {
    const host = new LoadingManager();
    host.addHandler(/\.host$/, new FileLoader(host));
    const scope = new LoadingScope(host, "tree.glts");

    expect(() => scope.manager.getHandler("asset.host"))
      .toThrow("cannot be scoped");

    const scopedHandler = new FileLoader(scope.manager);
    scope.manager.addHandler(/\.local$/, scopedHandler);
    expect(scope.manager.getHandler("asset.local")).toBe(scopedHandler);
  });
});
