import { expect, it, vi } from "vitest";
import * as physics from "@drawcall/physics";
import { Group, LoadingManager } from "three";
import { ExternalModules } from "../../src/modules/external.js";
import { ModuleBridge } from "../../src/modules/bridge.js";
import { ModuleURLStore } from "../../src/modules/urls.js";
import { Execution } from "../../src/scene/execution.js";
import { GLTSLoader } from "../../src/loader/index.js";
import { bindPhysics } from "../../src/modules/physics.js";

function execution(world: physics.PhysicsWorld) {
  const owner = new Execution([], [], undefined, () => Promise.resolve(world));
  const loader = new GLTSLoader(new LoadingManager());
  const context = owner.context({
    gltsLoader: loader,
    loadingManager: new LoadingManager(),
    isPreview: false,
  });
  return {
    owner,
    context,
    dispose() {
      owner.dispose();
      loader.dispose();
    },
  };
}

it("scopes transitive physics modules while sharing fetches and physics-free modules", async () => {
  const urls = new ModuleURLStore();
  const bridge = new ModuleBridge(urls);
  const requests: string[] = [];
  const world = new physics.AuthoringWorld();
  const first = execution(world),
    second = execution(world);
  const external = new ExternalModules({
    moduleURLs: urls,
    bridge,
    threeRevision: "185",
    cdnURL: new URL("https://cdn.test/"),
    fetch: async (input) => {
      const url = String(input);
      requests.push(url);
      return new Response(
        url.includes("helper")
          ? 'export { RigidBody } from "@drawcall/physics";'
          : "export const value = 1;",
        { headers: { "content-type": "application/javascript" } },
      );
    },
  });
  try {
    const a = external.forContext(first.context),
      b = external.forContext(second.context);
    const [one, two] = await Promise.all([
      a.prepareImport("helper", "https://cdn.test/entry.glts", []),
      b.prepareImport("helper", "https://cdn.test/entry.glts", []),
    ]);
    expect(one.physics).toBe(true);
    expect(two.physics).toBe(true);
    expect(one.url).not.toBe(two.url);
    expect(await a.prepareImport("helper", "https://cdn.test/entry.glts", [])).toBe(one);
    const [plainA, plainB] = await Promise.all([
      a.prepareImport("plain", "https://cdn.test/entry.glts", []),
      b.prepareImport("plain", "https://cdn.test/entry.glts", []),
    ]);
    expect(plainA).toBe(plainB);
    expect(requests).toHaveLength(2);
    expect(requests[0]).toContain("external=three,@drawcall/physics");
  } finally {
    first.dispose();
    second.dispose();
    world.dispose();
    bridge.dispose();
  }
});

it("retains host instanceof identity and disposes unparented bodies, joints and clones", () => {
  const world = new physics.AuthoringWorld();
  const scope = execution(world);
  const bound = bindPhysics(physics, scope.context, world);
  const options: physics.RigidBodyOptions = { mass: 2 };
  const body = new bound.RigidBody(options);
  expect(body.options).toEqual({ ...options, world });
  expect(options.world).toBeUndefined();
  body.options.mass = 3;
  expect(options.mass).toBe(2);
  expect(bound.getDefaultWorld()).toBe(world);
  class SpecializedBody extends bound.RigidBody {}
  expect(body).not.toBeInstanceOf(SpecializedBody);
  const specialized = new SpecializedBody();
  expect(specialized).toBeInstanceOf(SpecializedBody);
  specialized.dispose();
  const joint = new bound.FixedJoint({ body0: null, body1: body });
  expect(body).toBeInstanceOf(physics.RigidBody);
  expect(body.isGroup).toBe(true);
  expect(joint).toBeInstanceOf(physics.FixedJoint);
  expect(joint).toBeInstanceOf(bound.Joint);
  const hinge = new bound.RevoluteJoint({ body0: null, body1: body });
  expect(hinge).toBeInstanceOf(bound.AxisJoint);
  expect(hinge).toBeInstanceOf(bound.Joint);
  const assembly = new Group();
  assembly.add(body, joint, hinge);
  const cloned = bound.clone(assembly);
  expect(cloned).toBeInstanceOf(Group);
  expect(cloned.children[0]).toBeInstanceOf(bound.RigidBody);
  const clonedJoint = cloned.children[1];
  expect(clonedJoint).toBeInstanceOf(bound.FixedJoint);
  if (!(clonedJoint instanceof bound.FixedJoint))
    throw new Error("Expected cloned fixed joint");
  expect(clonedJoint.options.body1).toBe(cloned.children[0]);
  const bodyClone = body.clone();
  expect(bodyClone.world).toBe(world);
  expect(bodyClone).toBeInstanceOf(bound.RigidBody);
  bodyClone.dispose();
  expect(world.objects.size).toBe(0);
  scope.owner.commit();
  expect(world.objects.size).toBe(6);
  scope.dispose();
  expect(world.objects.size).toBe(0);
  expect(body.disposed).toBe(true);
  expect(() => new bound.RigidBody()).toThrow("disposed");
  expect(() => bound.clone(assembly)).toThrow("disposed");
  expect(() => bound.clone(new Group())).toThrow("disposed");
  expect(() => body.clone()).toThrow("disposed");
  world.dispose();
});

it("reuses the bridge only within an execution and refuses loads after bridge disposal", async () => {
  const bridge = new ModuleBridge(new ModuleURLStore());
  const world = new physics.AuthoringWorld();
  const scope = execution(world);
  const [a, b] = await Promise.all([
    bridge.getPhysicsModuleURL(scope.context),
    bridge.getPhysicsModuleURL(scope.context),
  ]);
  expect(a).toBe(b);
  bridge.dispose();
  await expect(bridge.getPhysicsModuleURL(scope.context)).rejects.toThrow(
    "disposed",
  );
  scope.dispose();
  world.dispose();
});


it("shares redirect aliases within an execution while isolating physics across executions", async () => {
  const urls = new ModuleURLStore();
  const release = vi.spyOn(urls, "release");
  const bridge = new ModuleBridge(urls);
  const world = new physics.AuthoringWorld();
  const first = execution(world);
  const second = execution(world);
  const external = new ExternalModules({
    moduleURLs: urls,
    bridge,
    threeRevision: "185",
    cdnURL: new URL("https://cdn.test/"),
    fetch: async () => {
      const response = new Response('export { RigidBody } from "@drawcall/physics";');
      Object.defineProperty(response, "url", { value: "https://cdn.test/canonical.js" });
      return response;
    },
  });
  try {
    const a = external.forContext(first.context);
    const b = external.forContext(second.context);
    const firstAlias = await a.prepareImport("https://cdn.test/first.js", "https://cdn.test/entry.glts", []);
    const secondAlias = await a.prepareImport("https://cdn.test/second.js", "https://cdn.test/entry.glts", []);
    const otherExecution = await b.prepareImport("https://cdn.test/second.js", "https://cdn.test/entry.glts", []);
    expect(secondAlias).toBe(firstAlias);
    expect(firstAlias.physics).toBe(true);
    expect(otherExecution.physics).toBe(true);
    expect(otherExecution.url).not.toBe(firstAlias.url);
    first.dispose();
    expect(release.mock.calls.filter(([url]) => url === firstAlias.url)).toHaveLength(1);
    expect(release).not.toHaveBeenCalledWith(otherExecution.url);
    second.dispose();
    expect(release.mock.calls.filter(([url]) => url === otherExecution.url)).toHaveLength(1);
  } finally {
    first.dispose();
    second.dispose();
    world.dispose();
    bridge.dispose();
  }
});

it("injects the captured world without mutating reusable options and honors explicit ownership", () => {
  const captured = new physics.AuthoringWorld();
  const other = new physics.AuthoringWorld();
  const scope = execution(captured);
  const bound = bindPhysics(physics, scope.context, captured);
  physics.setDefaultWorld(other);
  try {
    const options: physics.RigidBodyOptions = Object.freeze({ mass: 2 });
    const body = new bound.RigidBody(options);
    expect(body.world).toBe(captured);
    expect(body.options.world).toBe(captured);
    expect(options.world).toBeUndefined();
    const explicit = new bound.RigidBody({ ...options, world: other });
    expect(explicit.world).toBe(other);
    body.options.mass = 3;
    expect(options.mass).toBe(2);
    expect(explicit.options.mass).toBe(2);
  } finally {
    scope.dispose();
    captured.dispose();
    other.dispose();
  }
});
