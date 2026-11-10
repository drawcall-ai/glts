import { FileLoader, Loader, LoadingManager } from "three";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Dependencies } from "../../src/dependencies.js";
import { GLTSLoader } from "../../src/loader/index.js";
import { LoadScope } from "../../src/loader/scope.js";
import { assertUndisposed } from "../../src/nodes.js";
import type { GLTSScriptLoader } from "../../src/types.js";
import { base, deferred, serve } from "./fixture.js";

/** A scope of the script at `url` whose nested loads fail. */
function createScope(url: string, host: LoadingManager, dependencies = new Dependencies()): LoadScope {
  const unexpected = async (): Promise<never> => { throw new Error("Unexpected nested load"); };
  return new LoadScope({
    host,
    script: { requestedURL: url, executionURL: url },
    request: { ancestors: [] },
    dependencies,
    loader: { loadAsync: unexpected, loadInstancesAsync: unexpected },
    moduleSources: {},
    signal: new AbortController().signal,
  });
}

describe("LoadScope", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("waits only for resources started through its manager", async () => {
    const host = new LoadingManager();
    const first = createScope("first.glts", host);
    const second = createScope("second.glts", host);
    first.manager.itemStart("slow.bin");

    let firstSettled = false;
    const firstCompletion = first.settle().then(() => {
      firstSettled = true;
    });
    await expect(second.settle()).resolves.toBeUndefined();
    expect(firstSettled).toBe(false);

    first.manager.itemEnd("slow.bin");
    await firstCompletion;
  });

  it("isolates a resource failure from other scopes", async () => {
    const host = new LoadingManager();
    const successful = createScope("successful.glts", host);
    const failed = createScope("failed.glts", host);
    failed.manager.itemStart("missing.bin");
    failed.manager.itemError("missing.bin");
    failed.manager.itemEnd("missing.bin");

    await expect(successful.settle()).resolves.toBeUndefined();
    await expect(failed.settle()).rejects.toMatchObject({
      phase: "resource",
      url: "failed.glts"
    });
  });

  it("balances host notifications when callbacks throw", async () => {
    const onProgress = vi.fn(() => {
      throw new Error("progress failed");
    });
    const host = new LoadingManager(undefined, onProgress);
    const scope = createScope("tree.glts", host);
    scope.manager.itemStart("leaf.png");
    scope.manager.itemEnd("leaf.png");

    await expect(scope.settle()).rejects.toMatchObject({
      phase: "resource",
      url: "tree.glts"
    });
    expect(onProgress).toHaveBeenCalledOnce();
  });

  it("settles only once a resource started as another ends has ended, failing with it", async () => {
    const scope = createScope("tree.glts", new LoadingManager());
    scope.manager.itemStart("first.bin");
    const settling = scope.settle();
    scope.manager.itemEnd("first.bin");
    // As a loader's onLoad chaining another load would.
    await Promise.resolve();
    scope.manager.itemStart("second.bin");
    setTimeout(() => {
      scope.manager.itemError("second.bin");
      scope.manager.itemEnd("second.bin");
    });
    await expect(settling).rejects.toThrow("- second.bin");
  });

  it("aborts the resources still loading once disposed", async () => {
    const scope = createScope("tree.glts", new LoadingManager());
    await scope.settle();
    const { signal } = scope.manager.abortController;
    scope.dispose();
    expect(signal.aborted).toBe(true);
  });

  it("ends a late item it aborts on disposal for the host, without failing it", async () => {
    const host = new LoadingManager();
    const itemError = vi.spyOn(host, "itemError");
    const itemEnd = vi.spyOn(host, "itemEnd");
    const scope = createScope("tree.glts", host);
    await scope.settle();
    scope.manager.itemStart("streamed.bin");
    // As three's loaders answer an aborted request.
    scope.manager.abortController.signal.addEventListener("abort", () => {
      scope.manager.itemError("streamed.bin");
      scope.manager.itemEnd("streamed.bin");
    });
    scope.dispose();
    expect(itemEnd).toHaveBeenCalledExactlyOnceWith("streamed.bin");
    expect(itemError).not.toHaveBeenCalled();
  });

  it("rejects pending settlement when aborted", async () => {
    const scope = createScope("tree.glts", new LoadingManager());
    scope.manager.itemStart("slow.bin");
    const completion = scope.settle();
    await Promise.resolve();
    void scope.abort(new Error("aborted"));

    await expect(completion).rejects.toThrow("aborted");
    expect(() => scope.manager.itemStart("late.bin")).toThrow("no longer open");
  });

  it("rejects with the abort reason when aborted while waiting for nested loads, leaving their failures to abort()", async () => {
    const controller = new AbortController();
    const nestedFailure = new Error("nested failed");
    let fail: (error: unknown) => void = () => { throw new Error("Nested load has not started"); };
    const nested = new Promise<never>((_resolve, reject) => { fail = reject; });
    const scope = new LoadScope({
      host: new LoadingManager(),
      script: { requestedURL: `${base}tree.glts`, executionURL: `${base}tree.glts` },
      request: { ancestors: [] },
      dependencies: new Dependencies(),
      loader: { loadAsync: () => nested, loadInstancesAsync: () => nested },
      moduleSources: {},
      signal: controller.signal,
    });
    const loading = scope.gltsLoader.loadAsync("child.glts");
    const settling = scope.settle();
    const reason = new Error("aborted");
    controller.abort(reason);
    fail(nestedFailure);

    await expect(loading).rejects.toBe(nestedFailure);
    await expect(settling).rejects.toBe(reason);
    await expect(scope.abort(reason)).resolves.toEqual([nestedFailure]);
  });

  it("rejects host-bound handlers and accepts scoped handlers", () => {
    const host = new LoadingManager();
    host.addHandler(/\.host$/, new FileLoader(host));
    const scope = createScope("tree.glts", host);

    expect(() => scope.manager.getHandler("asset.host"))
      .toThrow("cannot be scoped");

    const scopedHandler = new FileLoader(scope.manager);
    scope.manager.addHandler(/\.local$/, scopedHandler);
    expect(scope.manager.getHandler("asset.local")).toBe(scopedHandler);
  });

  it("records relative resource URLs against the worker location, not the script URL", async () => {
    vi.stubGlobal("location", { href: "https://app.test/workers/worker.js" });
    const dependencies = new Dependencies();
    const scope = createScope("https://assets.test/scene.glts", new LoadingManager(), dependencies);
    scope.manager.itemStart("bark.png");
    scope.manager.itemEnd("bark.png");
    await scope.settle();
    expect(dependencies.urls()).toEqual(["https://app.test/workers/bark.png"]);
  });

  it("does not invent file dependencies for relative labels without a browser base", async () => {
    const dependencies = new Dependencies();
    const scope = createScope("https://assets.test/scene.glts", new LoadingManager(), dependencies);
    for (const label of ["custom work", "http://["]) {
      scope.manager.itemStart(label);
      scope.manager.itemEnd(label);
    }
    await scope.settle();
    expect(dependencies.urls()).toEqual([]);
  });
});

it.each(["loadAsync('./child.glts')", "loadInstancesAsync('./child.glts', 2)"])(
  "reports nested %s through its parent scope and waits for child resources",
  async (load) => {
    const parentStarts: string[] = [];
    const parentEnds: string[] = [];
    let finish: () => void = () => { throw new Error("Child resource has not started"); };
    const resourceStarted = deferred();
    let parentManager: LoadingManager | undefined;
    const loader = serve({
      "parent.glts": `import { scene, gltsLoader, loadingManager } from "@drawcall/glts";
        import { observe } from "library"; observe(loadingManager);
        scene.add(await gltsLoader.${load});`,
      "child.glts": `import { onMatrixUpdateAt, loadingManager } from "@drawcall/glts";
        import { resource } from "library"; onMatrixUpdateAt(() => {}); resource(loadingManager);`,
    }, {
      observe: (manager: LoadingManager) => {
        parentManager = manager;
        const start = manager.itemStart;
        const end = manager.itemEnd;
        manager.itemStart = (url) => { parentStarts.push(url); start(url); };
        manager.itemEnd = (url) => { parentEnds.push(url); end(url); };
      },
      resource: (manager: LoadingManager) => {
        manager.itemStart(`${base}texture.png`);
        finish = () => manager.itemEnd(`${base}texture.png`);
        resourceStarted.resolve();
      },
    });
    const hostStarts = vi.spyOn(loader.manager, "itemStart");
    const hostEnds = vi.spyOn(loader.manager, "itemEnd");
    const hostErrors = vi.spyOn(loader.manager, "itemError");
    let settled = false;
    const loading = loader.loadAsync(`${base}parent.glts`).then((scene) => { settled = true; return scene; });
    await resourceStarted.promise;
    expect(settled).toBe(false);
    expect(parentStarts).toEqual([`${base}child.glts`]);
    expect(parentEnds).toEqual([]);
    finish();
    await loading;
    expect(parentEnds).toEqual([`${base}child.glts`]);
    expect(hostStarts.mock.calls.flat()).toEqual([`${base}parent.glts`, `${base}child.glts`, `${base}texture.png`]);
    expect(hostEnds.mock.calls.flat()).toEqual([`${base}texture.png`, `${base}child.glts`, `${base}parent.glts`]);
    expect(hostErrors).not.toHaveBeenCalled();
    // Streamed after loading: the host's only.
    parentManager?.itemStart(`${base}late.png`);
    parentManager?.itemEnd(`${base}late.png`);
    expect(hostStarts.mock.calls.flat().at(-1)).toBe(`${base}late.png`);
    expect(hostEnds.mock.calls.flat().at(-1)).toBe(`${base}late.png`);
  },
);

it("balances failed nested loads once through the parent scope and host manager", async () => {
  const errors: string[] = [];
  const ends: string[] = [];
  const loader = serve({
    "parent.glts": `import { gltsLoader, loadingManager } from "@drawcall/glts";
      import { observe } from "library"; observe(loadingManager); await gltsLoader.loadAsync('./missing.glts');`,
  }, {
    observe: (manager: LoadingManager) => {
      manager.onError = (url) => { errors.push(url); };
      manager.onProgress = (url) => { ends.push(url); };
    },
  });
  const hostStarts = vi.spyOn(loader.manager, "itemStart");
  const hostEnds = vi.spyOn(loader.manager, "itemEnd");
  const hostErrors = vi.spyOn(loader.manager, "itemError");
  await expect(loader.loadAsync(`${base}parent.glts`)).rejects.toMatchObject({ phase: "fetch" });
  expect(errors).toEqual([`${base}missing.glts`]);
  expect(ends).toEqual([`${base}missing.glts`]);
  expect(hostStarts.mock.calls.flat()).toEqual([`${base}parent.glts`, `${base}missing.glts`]);
  expect(hostEnds.mock.calls.flat()).toEqual([`${base}missing.glts`, `${base}parent.glts`]);
  expect(hostErrors.mock.calls.flat()).toEqual([`${base}missing.glts`, `${base}parent.glts`]);
});

it("names a resource whose failure the script's own failure carried out", async () => {
  // A missing image's empty body fails to decode, which names no URL.
  vi.stubGlobal("createImageBitmap", async () => { throw new Error("Input Buffer is empty"); });
  const loader = serve({
    "parent.glts": `import { ImageBitmapLoader } from "three";
      import { loadingManager } from "@drawcall/glts";
      await new ImageBitmapLoader(loadingManager).loadAsync("${base}missing.png");`,
  });
  await expect(loader.loadAsync(base + "parent.glts")).rejects.toMatchObject({
    message: expect.stringContaining("GLTS execution and its loads both failed"),
    cause: { errors: [
      { cause: { message: "Input Buffer is empty" } },
      { phase: "resource", message: expect.stringContaining(`- ${base}missing.png`) },
    ] },
  });
});

it("fails with the phase and URL of a nested load the script catches", async () => {
  const loader = serve({
    "parent.glts": `import { gltsLoader } from "@drawcall/glts"; gltsLoader.loadAsync('./missing.glts').catch(() => undefined);`,
  });
  await expect(loader.loadAsync(`${base}parent.glts`)).rejects.toMatchObject({ phase: "fetch", url: `${base}missing.glts` });
});

it("balances a nested load of a reloading script when its parent fails", async () => {
  const reloadReleased = deferred();
  const reloadEntered = deferred();
  const parentCancelled = deferred();
  const sources = {
    "child.glts": "",
    "parent.glts": `import { scene, gltsLoader, loadingManager } from "@drawcall/glts";
      import { observe } from "library"; observe(loadingManager);
      void gltsLoader.loadAsync('./child.glts').then((child) => scene.add(child));
      throw new Error('parent failed');`,
  };
  const loader = serve(sources, {
    pause: () => { reloadEntered.resolve(); return reloadReleased.promise; },
    observe: (manager: LoadingManager) => {
      manager.abortController.signal.addEventListener("abort", parentCancelled.resolve);
    },
  });
  await loader.loadAsync(`${base}child.glts`);
  sources["child.glts"] = `import { pause } from "library"; await pause();`;
  const hostStarts = vi.spyOn(loader.manager, "itemStart");
  const hostEnds = vi.spyOn(loader.manager, "itemEnd");
  const hostErrors = vi.spyOn(loader.manager, "itemError");
  const reloading = loader.reload(`${base}child.glts`);
  await reloadEntered.promise;
  const parentResult = loader.loadAsync(`${base}parent.glts`).catch((error: unknown) => error);
  await parentCancelled.promise;
  expect(hostStarts.mock.calls.flat()).toEqual([`${base}child.glts`, `${base}parent.glts`, `${base}child.glts`]);
  reloadReleased.resolve();
  await reloading;
  expect(await parentResult).toMatchObject({ phase: "evaluate", cause: { message: "parent failed" } });
  expect(hostEnds.mock.calls.flat()).toEqual([`${base}child.glts`, `${base}child.glts`, `${base}parent.glts`]);
  expect(hostErrors.mock.calls.flat()).toEqual([`${base}parent.glts`]);
});

it("serves as its loading manager's .glts handler, publishing the host's moduleSources", async () => {
  serve({
    "parent.glts": `import { scene, gltsLoader, loadingManager } from "@drawcall/glts";
      import { library } from "library";
      loadingManager.addHandler(/\\.glts$/, gltsLoader);
      scene.add(await library(loadingManager, "./child.glts"));`,
    "child.glts": `import { scene } from "@drawcall/glts"; scene.name = "child";`,
  });
  let handler: Loader | null = null;
  const library = async (manager: LoadingManager, url: string): Promise<unknown> => {
    handler = manager.getHandler(url);
    return handler?.loadAsync(url);
  };
  const moduleSources = { "pkg@1": { packages: ["pkg"], moduleHashes: { "https://cdn.test/pkg.js": "hash" } } };
  const loader = new GLTSLoader(new LoadingManager(), { moduleSources, modules: { "pkg@1": {}, library: { library } } });
  try {
    const parent = await loader.loadAsync(`${base}parent.glts`);
    expect(parent.children.map((child) => child.name)).toEqual(["child"]);
    expect(handler).toBeInstanceOf(Loader);
    expect(Reflect.get(handler ?? {}, "moduleSources")).toEqual(moduleSources);
  } finally {
    loader.dispose();
  }
});

it("owns nested scenes, attached or not, and loads more after settling, for the host only, until disposed with them", async () => {
  let contextual: GLTSScriptLoader | undefined;
  const loader = serve({
    "parent.glts": `import { gltsLoader } from "@drawcall/glts"; import { keep } from "library";
      keep(gltsLoader, await gltsLoader.loadAsync("./child.glts"));`,
    "child.glts": "",
    "other.glts": "",
  }, { keep: (scriptLoader: GLTSScriptLoader) => { contextual = scriptLoader; } });
  const parent = await loader.loadAsync(`${base}parent.glts`);
  const { dependencyUrls } = parent.source;
  expect(dependencyUrls).toContain(`${base}child.glts`);
  if (!contextual) throw new Error("The script did not run");
  const hostStarts = vi.spyOn(loader.manager, "itemStart");
  const late = await contextual.loadAsync("./other.glts");
  expect(hostStarts.mock.calls.flat()).toEqual([`${base}other.glts`]);
  await expect(contextual.loadAsync("./missing.glts")).rejects.toMatchObject({ phase: "fetch" });
  // Loads after settling are not the script's dependencies.
  expect(parent.source.dependencyUrls).toEqual(dependencyUrls);
  const disposed = vi.fn();
  late.addEventListener("dispose", disposed);
  parent.dispose();
  expect(() => assertUndisposed(late)).toThrow();
  expect(disposed).toHaveBeenCalledOnce();
  await expect(contextual.loadAsync("./child.glts")).rejects.toThrow("no longer open");
});

it("disposes a nested scene whose load settling after the script ended resolves once the script was disposed", async () => {
  const released = deferred();
  const entered = deferred();
  let contextual: GLTSScriptLoader | undefined;
  const loader = serve({
    "parent.glts": `import { gltsLoader } from "@drawcall/glts"; import { keep } from "library"; keep(gltsLoader);`,
    "child.glts": `import { pause } from "library"; await pause();`,
  }, {
    keep: (scriptLoader: GLTSScriptLoader) => { contextual = scriptLoader; },
    pause: () => { entered.resolve(); return released.promise; },
  });
  const parent = await loader.loadAsync(`${base}parent.glts`);
  if (!contextual) throw new Error("The script did not run");
  const late = contextual.loadAsync("./child.glts");
  await entered.promise;
  parent.dispose();
  released.resolve();
  await expect(late).rejects.toThrow("was disposed");
});

it("waits for nested loads started while waiting for resources, failing once with them", async () => {
  const loader = serve({
    "parent.glts": `import { gltsLoader, loadingManager } from "@drawcall/glts";
      loadingManager.itemStart("work");
      setTimeout(() => { gltsLoader.loadAsync("./missing.glts").catch(() => undefined); loadingManager.itemEnd("work"); });`,
  });
  const hostErrors = vi.spyOn(loader.manager, "itemError");
  await expect(loader.loadAsync(`${base}parent.glts`)).rejects.toMatchObject({ phase: "fetch", url: `${base}missing.glts` });
  expect(hostErrors.mock.calls.flat()).toEqual([`${base}missing.glts`, `${base}parent.glts`]);
});
