import { describe, expect, it } from "vitest";

import { GLTSError } from "./errors.js";
import { RuntimeLoading } from "./loading.js";

describe("RuntimeLoading", () => {
  it("waits for every tracked resource to finish", async () => {
    const loading = new RuntimeLoading("tree-runtime");
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
    const loading = new RuntimeLoading("tree-runtime");
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
    const loading = new RuntimeLoading("tree-runtime");
    const boundary = loading.begin("https://example.test/tree.glts");
    const resourceURL = "https://example.test/missing.png";
    loading.manager.itemStart(resourceURL);
    loading.manager.itemError(resourceURL);
    loading.manager.itemEnd(resourceURL);

    await expect(boundary.waitForIdle()).rejects.toBeInstanceOf(GLTSError);
  });

  it("shares an active failure with boundaries that join before idle", async () => {
    const loading = new RuntimeLoading("shared-runtime");
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
    const first = new RuntimeLoading("first-runtime");
    const second = new RuntimeLoading("second-runtime");
    const firstBoundary = first.begin("https://example.test/first.glts");
    const secondBoundary = second.begin("https://example.test/second.glts");
    first.manager.itemStart("https://example.test/slow.png");

    await expect(secondBoundary.waitForIdle()).resolves.toBeUndefined();

    const firstCompletion = firstBoundary.waitForIdle();
    first.manager.itemEnd("https://example.test/slow.png");
    await expect(firstCompletion).resolves.toBeUndefined();
  });

  it("gives the same resource a runtime-specific Three.js key", () => {
    const first = new RuntimeLoading("first-runtime");
    const second = new RuntimeLoading("second-runtime");
    const resourceURL = "https://example.test/model.glb?version=1#scene";
    first.manager.setURLModifier((url) => {
      const modified = new URL(url);
      modified.searchParams.set("token", "first");
      return modified.href;
    });

    const firstURL = first.manager.resolveURL(resourceURL);
    const repeatedFirstURL = first.manager.resolveURL(resourceURL);
    const secondURL = second.manager.resolveURL(resourceURL);

    expect(firstURL).toBe(repeatedFirstURL);
    expect(firstURL).not.toBe(secondURL);
    expect(new URL(firstURL).href).toBe(
      "https://example.test/model.glb?version=1&token=first#scene"
    );
    expect(new URL(secondURL).href).toBe(resourceURL);
  });

  it("keeps runtime URL aliases out of loading callbacks and failures", async () => {
    const loading = new RuntimeLoading("tree-runtime");
    const rootURL = "https://example.test/tree.glts";
    const resourceURL = "https://example.test/icons.svg#leaf";
    const managedURL = loading.manager.resolveURL(resourceURL);
    const events: string[] = [];
    loading.manager.onStart = (url) => events.push(`start:${url}`);
    loading.manager.onError = (url) => events.push(`error:${url}`);
    loading.manager.onProgress = (url) => events.push(`progress:${url}`);
    const boundary = loading.begin(rootURL);

    loading.manager.itemStart(managedURL);
    loading.manager.itemError(managedURL);
    const completion = boundary.waitForIdle();
    loading.manager.itemEnd(managedURL);

    await expect(completion).rejects.toThrow(resourceURL);
    expect(events).toEqual([
      `start:${resourceURL}`,
      `error:${resourceURL}`,
      `progress:${resourceURL}`
    ]);
  });

  it("preserves data and blob resource identity", async () => {
    const loading = new RuntimeLoading("asset-runtime");
    const dataURL = "data:text/plain,leaf#source";
    const blobURL = URL.createObjectURL(new Blob(["branch"]));

    try {
      const [data, blob] = await Promise.all([
        fetch(loading.manager.resolveURL(dataURL)).then((response) => response.text()),
        fetch(loading.manager.resolveURL(blobURL)).then((response) => response.text())
      ]);
      expect({ blob, data }).toEqual({ blob: "branch", data: "leaf" });
    } finally {
      URL.revokeObjectURL(blobURL);
    }
  });
});
