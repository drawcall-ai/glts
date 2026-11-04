import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { inspect } from "node:util";
import { requestAdapter } from "@drawcall/webgpu";
import { afterAll, expect, it } from "vitest";

import { withHeadless } from "../src/headless/index.js";

const directory = await mkdtemp(join(tmpdir(), "glts-headless-"));
const baseURL = pathToFileURL(`${directory}/`);
const options = { projectURL: baseURL, baseURL, size: 1, loader: {} };
const descriptors = () => ["fetch", "document", "self", "createImageBitmap", "Worker", "OffscreenCanvas"].map((key) => Object.getOwnPropertyDescriptor(globalThis, key));

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

it("uploads 2D canvases to textures as Three's CanvasTexture does", async () => {
  await withHeadless(options, async () => {
    const canvas = new OffscreenCanvas(1, 2);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Missing 2D context");
    context.fillStyle = "#ff0000";
    context.fillRect(0, 0, 1, 1);
    context.fillStyle = "#0000ff";
    context.fillRect(0, 1, 1, 1);

    const adapter = await requestAdapter();
    if (!adapter) throw new Error("WebGPU is unavailable");
    const device = await adapter.requestDevice();
    const texture = device.createTexture({ size: [1, 2], format: "rgba8unorm", usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC });
    const buffer = device.createBuffer({ size: 512, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    device.queue.copyExternalImageToTexture({ source: canvas, flipY: true }, { texture }, [1, 2]);
    const encoder = device.createCommandEncoder();
    encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow: 256 }, [1, 2]);
    device.queue.submit([encoder.finish()]);
    await buffer.mapAsync(GPUMapMode.READ);
    const rows = new Uint8Array(buffer.getMappedRange());
    expect([...rows.subarray(0, 4), ...rows.subarray(256, 260)]).toEqual([0, 0, 255, 255, 255, 0, 0, 255]);
    device.destroy();
  });
});

it("runs browser code that needs canvases, decoded images, and module workers", async () => {
  const before = descriptors();
  const worker = join(directory, "worker.js");
  await writeFile(worker, `
    await Promise.resolve();
    addEventListener("message", ({ data }) => {
      postMessage({ scope: globalThis instanceof WorkerGlobalScope, sum: new Uint8Array(data).reduce((a, b) => a + b) }, [data]);
    });
  `);
  await withHeadless(options, async () => {
    const canvas = document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
    expect(canvas instanceof OffscreenCanvas && canvas.getContext("2d")).toBeTruthy();

    const sharp = (await import("sharp")).default;
    const pixels = Buffer.from([255, 0, 0, 255, 0, 0, 255, 128]);
    const file = await sharp(pixels, { raw: { width: 2, height: 1, channels: 4 } }).png().toBuffer();
    const bitmap = await createImageBitmap(new Blob([new Uint8Array(file)]), { premultiplyAlpha: "none", colorSpaceConversion: "none" });
    const context = new OffscreenCanvas(2, 1).getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("Missing 2D context");
    context.drawImage(bitmap, 0, 0);
    expect([...context.getImageData(0, 0, 2, 1, { colorSpace: "srgb" }).data]).toEqual([255, 0, 0, 255, 0, 0, 255, 128]);

    const thread = new Worker(pathToFileURL(worker), { type: "module" });
    const reply = new Promise<unknown>((resolve, reject) => {
      thread.onmessage = (event) => resolve(event.data);
      thread.onerror = (event) => reject(new Error(String(Reflect.get(event, "message"))));
    });
    const data = new Uint8Array([1, 2, 3]).buffer;
    thread.postMessage(data, [data]);
    expect(await reply).toEqual({ scope: true, sum: 6 });
    thread.terminate();
  });
  expect(descriptors()).toEqual(before);
});
