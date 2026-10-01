import { expect, it, vi } from "vitest";
import * as physics from "@drawcall/physics";
import { Group, LoadingManager } from "three";
import { ExternalModules } from "../../src/modules/external.js";
import { ModuleBridge } from "../../src/modules/bridge.js";
import { ModuleURLStore } from "../../src/modules/urls.js";
import { Execution } from "../../src/scene/execution.js";
import { GLTSLoader } from "../../src/loader/index.js";
import { bindPhysics } from "../../src/modules/physics.js";

function execution() {
  const owner = new Execution([], []);
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
  const first = execution(),
    second = execution();
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
      bridge.dispose();
  }
});

it("retains host instanceof identity and disposes unparented bodies, joints and clones", () => {
  const scope = execution();
  const bound = bindPhysics(physics, scope.context);
  const options: physics.RigidBodyOptions = { mass: 2 };
  const body = new bound.RigidBody(options);
  expect(body.options.mass).toBe(2);
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
  const drive = new bound.JointDrive({ stiffness: 100, damping: 10 });
  hinge.setDrive(drive.setTarget({ position: 0.5 }));
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
  const clonedHinge = cloned.children[2];
  if (!(clonedHinge instanceof bound.RevoluteJoint))
    throw new Error("Expected cloned hinge");
  const clonedDrive = clonedHinge.drive;
  expect(clonedDrive).toBeInstanceOf(physics.JointDrive);
  expect(clonedDrive).not.toBe(drive);
  expect(clonedDrive?.joint).toBe(clonedHinge);
  expect(clonedDrive?.target).toEqual({ position: 0.5, velocity: 0, effort: 0 });
  const bodyClone = body.clone();
  expect(bodyClone).toBeInstanceOf(bound.RigidBody);
  bodyClone.dispose();
  expect(physics.registry.objects.size).toBe(0);
  scope.owner.commit();
  expect(physics.registry.objects.size).toBe(6);
  scope.dispose();
  expect(physics.registry.objects.size).toBe(0);
  expect(body.disposed).toBe(true);
  expect(drive.joint).toBeUndefined();
  expect(clonedDrive?.joint).toBeUndefined();
  expect(() => new bound.RigidBody()).toThrow("disposed");
  expect(() => bound.clone(assembly)).toThrow("disposed");
  expect(() => bound.clone(new Group())).toThrow("disposed");
  expect(() => body.clone()).toThrow("disposed");
});

it("reuses the bridge only within an execution and refuses loads after bridge disposal", async () => {
  const bridge = new ModuleBridge(new ModuleURLStore());
  const scope = execution();
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
});


it("shares redirect aliases within an execution while isolating physics across executions", async () => {
  const urls = new ModuleURLStore();
  const release = vi.spyOn(urls, "release");
  const bridge = new ModuleBridge(urls);
  const first = execution();
  const second = execution();
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
      bridge.dispose();
  }
});
