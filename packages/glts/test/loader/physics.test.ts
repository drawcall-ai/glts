import { expect, it, vi } from "vitest";
import * as physics from "@drawcall/physics";
import { BoxGeometry, Group, LoadingManager, Mesh, MeshStandardMaterial, Vector3 } from "three";
import { LoaderRuntime } from "../../src/loader/runtime.js";
import { createContextLoader } from "../../src/loader/context.js";
import { ScriptModules } from "../../src/modules/scripts.js";
import { ModuleBridge } from "../../src/modules/bridge.js";
import { ModuleURLStore } from "../../src/modules/urls.js";
import { bindPhysics } from "../../src/modules/physics.js";
import type { ScriptContext } from "../../src/scene/execution.js";

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function fixture(execute: (url: string, context: ScriptContext) => Promise<void>) {
  const world = new physics.AuthoringWorld();
  const urls = new ModuleURLStore();
  const bridge = new ModuleBridge(urls);
  const modules = new ScriptModules({
    cdnURL: new URL("https://cdn.test/"), fetch: async () => new Response(""),
    moduleURLs: urls, bridge, threeRevision: "185"
  });
  vi.spyOn(modules, "executeScript").mockImplementation((script, context) => execute(script.url, context));
  const runtime: LoaderRuntime = new LoaderRuntime({
    modules, manager: new LoadingManager(), physicsWorld: world,
    contextLoader: (owner) => createContextLoader(owner, runtime, String)
  });
  return { world, runtime, dispose() { runtime.dispose(); bridge.dispose(); world.dispose(); } };
}

async function assembly(context: ScriptContext) {
  const bound = bindPhysics(physics, context, await context.physicsWorld());
  context.declarePhysics();
  const body = new bound.RigidBody({ mass: 2 });
  body.scale.setScalar(2);
  const geometry = new BoxGeometry();
  const material = new MeshStandardMaterial();
  body.add(new Mesh(geometry, material));
  const joint = new bound.FixedJoint({ body0: null, body1: body });
  context.scene.add(body, joint);
  context.onDispose(() => { geometry.dispose(); material.dispose(); });
  return { body, joint };
}

it("stages nested bodies and joints until the outer load completes", async () => {
  const ready = deferred(), finish = deferred();
  const test = fixture(async (url, context) => {
    if (url.endsWith("child.glts")) {
      await assembly(context);
      return;
    }
    const child = await context.gltsLoader.loadAsync("https://test/child.glts");
    child.scale.setScalar(3);
    context.scene.add(child);
    ready.resolve();
    await finish.promise;
  });
  try {
    const loading = test.runtime.load("https://test/parent.glts", false);
    await ready.promise;
    expect(test.world.objects.size).toBe(0);
    finish.resolve();
    const scene = await loading;
    const host = new Group();
    host.scale.setScalar(4);
    host.add(scene);
    expect(test.world.objects.size).toBe(2);
    const body = [...test.world.objects].find(object => object instanceof physics.RigidBody);
    if (!(body instanceof physics.RigidBody)) throw new Error("Missing body");
    expect(body.getWorldScale(new Vector3()).toArray()).toEqual([24, 24, 24]);
    scene.dispose();
    expect(test.world.objects.size).toBe(0);
  } finally { test.dispose(); }
});

it.each([false, true])("keeps live physics during reload and disposes staged revisions on failure=%s", async (fail) => {
  const ready = deferred(), finish = deferred();
  let reloading = false;
  const test = fixture(async (_url, context) => {
    await assembly(context);
    if (!reloading) return;
    ready.resolve();
    await finish.promise;
    if (fail) throw new Error("Reload failed");
  });
  try {
    const scene = await test.runtime.load("https://test/asset.glts", false);
    scene.scale.setScalar(3);
    const previous = [...test.world.objects];
    reloading = true;
    const reload = scene.reload();
    await ready.promise;
    expect([...test.world.objects]).toEqual(previous);
    finish.resolve();
    if (fail) {
      await expect(reload).rejects.toMatchObject({ phase: "evaluate" });
      expect([...test.world.objects]).toEqual(previous);
      expect(previous.every(object => !object.disposed)).toBe(true);
      return;
    }
    await reload;
    expect(test.world.objects.size).toBe(2);
    expect(previous.every(object => object.disposed)).toBe(true);
    const body = [...test.world.objects].find(object => object instanceof physics.RigidBody);
    if (!(body instanceof physics.RigidBody)) throw new Error("Missing replacement");
    expect(body.parent).toBe(scene);
    expect(body.getWorldScale(new Vector3()).toArray()).toEqual([6, 6, 6]);
  } finally { test.dispose(); }
});

it("activates a committed replacement even when previous cleanup throws", async () => {
  let first = true;
  const test = fixture(async (_url, context) => {
    await assembly(context);
    if (first) {
      first = false;
      context.onDispose(() => { throw new Error("Cleanup failed"); });
    }
  });
  try {
    const scene = await test.runtime.load("https://test/asset.glts", false);
    const previous = [...test.world.objects];
    await expect(scene.reload()).rejects.toThrow("Reload committed, but cleanup failed");
    expect(previous.every(object => object.disposed)).toBe(true);
    expect(test.world.objects.size).toBe(2);
    expect([...test.world.objects].every(object => object.parent === scene)).toBe(true);
  } finally { test.dispose(); }
});

it("discards joints attached to bodies disposed during construction", async () => {
  const test = fixture(async (_url, context) => {
    const { body } = await assembly(context);
    body.dispose();
  });
  try {
    const scene = await test.runtime.load("https://test/asset.glts", false);
    expect(test.world.objects.size).toBe(0);
    expect(scene.children).toHaveLength(0);
  } finally { test.dispose(); }
});

it("cleans the unreturned scene when its world is disposed during loading", async () => {
  const ready = deferred(), finish = deferred();
  const dispose = vi.fn();
  const test = fixture(async (_url, context) => {
    await assembly(context);
    context.onDispose(dispose);
    ready.resolve();
    await finish.promise;
  });
  try {
    const loading = test.runtime.load("https://test/asset.glts", false);
    await ready.promise;
    test.world.dispose();
    finish.resolve();
    await expect(loading).rejects.toMatchObject({ phase: "construct" });
    expect(dispose).toHaveBeenCalledOnce();
    expect(test.world.objects.size).toBe(0);
  } finally { test.dispose(); }
  expect(dispose).toHaveBeenCalledOnce();
});
