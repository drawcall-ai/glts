import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { routeGLTS, routeGLTSRevisions } from "./routes.js";

const physical = `
  import { scene } from "@drawcall/glts";
  import { RigidBody } from "@drawcall/physics";
  import { BoxGeometry, Mesh, MeshStandardMaterial } from "three";
  const body = new RigidBody();
  body.add(new Mesh(new BoxGeometry(), new MeshStandardMaterial()));
  scene.add(body);
`;

test("shares physics constructors across host and concurrent loaders", async ({
  page,
}) => {
  await routeGLTS(page, "**/body.glts", physical);
  await page.goto("/test-harness.html");
  const result = await page.evaluate(async () => {
    const { AuthoringWorld, setDefaultWorld } = await window.physicsModule();
    setDefaultWorld(new AuthoringWorld());
    const a = new window.GLTSLoader(new window.LoadingManager());
    const b = new window.GLTSLoader(new window.LoadingManager());
    const [first, second] = await Promise.all([
      a.loadAsync("/body.glts"),
      b.loadAsync("/body.glts"),
    ]);
    const { RigidBody } = await window.physicsModule();
    const result = [
      first.capabilities.physics,
      second.capabilities.physics,
      first.children[0] instanceof RigidBody,
      second.children[0] instanceof RigidBody,
      first.children[0] instanceof window.Group,
    ];
    a.dispose();
    b.dispose();
    return result;
  });
  expect(result).toEqual([true, true, true, true, true]);
});

test("retains transitive declarations when external modules are cached", async ({
  page,
}) => {
  await page.route("https://physics.test/helper.js", (route) =>
    route.fulfill({
      contentType: "application/javascript",
      body: `export { RigidBody } from "@drawcall/physics";`,
      headers: { "access-control-allow-origin": "*" },
    }),
  );
  await routeGLTS(
    page,
    "**/helper.glts",
    `
    import { scene } from "@drawcall/glts";
    import { RigidBody } from "https://physics.test/helper.js";
    scene.add(new RigidBody({ type: "static" }));
  `,
  );
  await routeGLTS(
    page,
    "**/plain.glts",
    `import { scene } from "@drawcall/glts"; scene.name = "plain";`,
  );
  await page.goto("/test-harness.html");
  const result = await page.evaluate(async () => {
    const { AuthoringWorld, setDefaultWorld } = await window.physicsModule();
    setDefaultWorld(new AuthoringWorld());
    const loader = new window.GLTSLoader(new window.LoadingManager());
    const first = await loader.loadAsync("/helper.glts");
    const second = await loader.loadAsync("/helper.glts");
    const plain = await loader.loadAsync("/plain.glts");
    const flags = [
      first.capabilities.physics,
      second.capabilities.physics,
      plain.capabilities.physics,
    ];
    loader.dispose();
    return flags;
  });
  expect(result).toEqual([true, true, false]);
});

test("nested declarations refresh only on successful reload", async ({
  page,
}) => {
  await routeGLTS(
    page,
    "**/parent.glts",
    `
    import { gltsLoader, scene } from "@drawcall/glts";
    scene.add(await gltsLoader.loadAsync(new URL("./child.glts", import.meta.url)));
  `,
  );
  await routeGLTSRevisions(page, "**/child.glts", [
    physical,
    `throw new Error("failed replacement");`,
    `import { scene } from "@drawcall/glts"; scene.name = "plain";`,
  ]);
  await page.goto("/test-harness.html");
  const result = await page.evaluate(async () => {
    const { AuthoringWorld, setDefaultWorld } = await window.physicsModule();
    setDefaultWorld(new AuthoringWorld());
    const loader = new window.GLTSLoader(new window.LoadingManager());
    const parent = await loader.loadAsync("/parent.glts");
    const flags = [parent.capabilities.physics];
    try {
      await loader.reload("/child.glts");
    } catch {
      /* Deliberate failed revision. */
    }
    flags.push(parent.capabilities.physics);
    await loader.reload("/child.glts");
    flags.push(parent.capabilities.physics);
    loader.dispose();
    flags.push(parent.capabilities.physics);
    return flags;
  });
  expect(result).toEqual([true, true, false, false]);
});

test("rejects physics instancing instead of creating one collider for many visuals", async ({
  page,
}) => {
  await routeGLTS(page, "**/body.glts", physical);
  await page.goto("/test-harness.html");
  const result = await page.evaluate(async () => {
    const { AuthoringWorld, setDefaultWorld } = await window.physicsModule();
    setDefaultWorld(new AuthoringWorld());
    const loader = new window.GLTSLoader(new window.LoadingManager());
    try {
      await loader.loadInstancesAsync("/body.glts", 3);
      return "unexpected success";
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    } finally {
      loader.dispose();
    }
  });
  expect(result).toContain("Physics assets do not support loadInstancesAsync");
});

test("exports a declared physical asset through the lazy USD integration", async ({
  page,
}) => {
  await routeGLTS(page, "**/body.glts", physical);
  await page.goto("/test-harness.html");
  const result = await page.evaluate(async () => {
    const { AuthoringWorld, setDefaultWorld } = await window.physicsModule();
    setDefaultWorld(new AuthoringWorld());
    const loader = new window.GLTSLoader(new window.LoadingManager());
    try {
      const asset = await loader.loadAsync("/body.glts");
      const bytes = await new window.GLTSUSDExporter().parseAsync(asset);
      return {
        zip: Array.from(bytes.slice(0, 2)),
        size: bytes.byteLength,
        physics: new TextDecoder()
          .decode(bytes)
          .includes("PhysicsRigidBodyAPI"),
      };
    } finally {
      loader.dispose();
    }
  });
  expect(result.zip).toEqual([80, 75]);
  expect(result.size).toBeGreaterThan(100);
  expect(result.physics).toBe(true);
});

test("loads and exports the complete ragdoll example", async ({
  page,
}) => {
  const source = await readFile(
    new URL("../../physics/public/ragdoll.glts", import.meta.url),
    "utf8",
  );
  await routeGLTS(page, "**/ragdoll.glts", source);
  await page.goto("/test-harness.html");
  const result = await page.evaluate(async () => {
    const { AuthoringWorld, setDefaultWorld } = await window.physicsModule();
    setDefaultWorld(new AuthoringWorld());
    const loader = new window.GLTSLoader(new window.LoadingManager());
    try {
      const asset = await loader.loadAsync("/ragdoll.glts");
      const { RigidBody, Joint } = await window.physicsModule();
      const colliders: number[] = [];
      const contacts: boolean[] = [];
      let joints = 0;
      asset.traverse((object) => {
        if (object instanceof RigidBody)
          colliders.push(object.getColliders().length);
        if (object instanceof Joint) {
          object.validate();
          contacts.push(object.collideConnected);
          joints++;
        }
      });
      const pelvis = asset.getObjectByName("Pelvis");
      if (!(pelvis instanceof RigidBody)) throw new Error("Missing pelvis");
      const output = await new window.GLTSUSDExporter().parseAsync(asset);
      return {
        velocity: pelvis.getVelocity().linear.toArray(),
        contacts,
        bodies: colliders.length,
        colliders,
        joints,
        hinge: new TextDecoder()
          .decode(output)
          .includes("PhysicsRevoluteJoint"),
      };
    } finally {
      loader.dispose();
    }
  });
  expect(result).toEqual({
    velocity: [0.6, 0, 0.8],
    contacts: Array(10).fill(true),
    bodies: 12,
    colliders: Array(12).fill(1),
    joints: 10,
    hinge: true,
  });
});

test("isolates async executions and cached helper constructors across default worlds", async ({
  page,
}) => {
  await page.route("https://physics.test/owned.js", (route) =>
    route.fulfill({
      contentType: "application/javascript",
      headers: { "access-control-allow-origin": "*" },
      body: `import { RigidBody } from "@drawcall/physics";
      export const body = new RigidBody();
      export const create = () => new RigidBody();`,
    }),
  );
  await routeGLTS(
    page,
    "**/async.glts",
    `
    import { scene, onFrame } from "@drawcall/glts";
    import { body, create } from "https://physics.test/owned.js";
    scene.add(body);
    Reflect.set(globalThis, "physicsExecutionStarted", true);
    await new Promise(resolve => setTimeout(resolve, 50));
    create();
    onFrame(() => create());
  `,
  );
  await page.goto("/test-harness.html");
  const result = await page.evaluate(async () => {
    const { AuthoringWorld, RigidBody, setDefaultWorld } =
      await window.physicsModule();
    const firstWorld = new AuthoringWorld(),
      secondWorld = new AuthoringWorld();
    const loader = new window.GLTSLoader(new window.LoadingManager());
    setDefaultWorld(firstWorld);
    const pending = loader.loadAsync("/async.glts");
    while (!Reflect.get(globalThis, "physicsExecutionStarted"))
      await new Promise((resolve) => setTimeout(resolve, 0));
    setDefaultWorld(secondWorld);
    const [first, second] = await Promise.all([
      pending,
      loader.loadAsync("/async.glts"),
    ]);
    first.update(0);
    second.update(0);
    const a = first.children[0],
      b = second.children[0];
    const before = [firstWorld.objects.size, secondWorld.objects.size];
    const worlds = [
      a instanceof RigidBody && a.world === firstWorld,
      b instanceof RigidBody && b.world === secondWorld,
    ];
    first.dispose();
    const after = [firstWorld.objects.size, secondWorld.objects.size];
    loader.dispose();
    const final = [firstWorld.objects.size, secondWorld.objects.size];
    firstWorld.dispose();
    secondWorld.dispose();
    return { before, worlds, after, final };
  });
  expect(result).toEqual({
    before: [3, 3],
    worlds: [true, true],
    after: [0, 3],
    final: [0, 0],
  });
});

test("cleans failed loads and failed reloads without unregistering the current asset", async ({
  page,
}) => {
  const orphan = `import { RigidBody } from "@drawcall/physics"; new RigidBody();`;
  await routeGLTS(
    page,
    "**/failure.glts",
    `${orphan} throw new Error("failed construction");`,
  );
  await routeGLTSRevisions(page, "**/reload-owned.glts", [
    physical,
    `${orphan} throw new Error("failed reload");`,
  ]);
  await page.goto("/test-harness.html");
  const result = await page.evaluate(async () => {
    const { AuthoringWorld } = await window.physicsModule();
    const world = new AuthoringWorld();
    const loader = new window.GLTSLoader(new window.LoadingManager(), {
      physicsWorld: world,
    });
    const failure = await loader.loadAsync("/failure.glts").then(
      () => "unexpected",
      (error) => String(window.readErrorField(error, "cause") ?? error),
    );
    const afterFailure = world.objects.size;
    const asset = await loader.loadAsync("/reload-owned.glts");
    const original = asset.children[0];
    const reload = await asset.reload().then(
      () => "unexpected",
      (error) => String(window.readErrorField(error, "cause") ?? error),
    );
    const retained = asset.children[0] === original;
    const afterReload = world.objects.size;
    loader.dispose();
    const afterDispose = world.objects.size;
    world.dispose();
    return {
      failure,
      reload,
      retained,
      counts: [afterFailure, afterReload, afterDispose],
    };
  });
  expect(result.failure).toContain("failed construction");
  expect(result.reload).toContain("failed reload");
  expect(result.retained).toBe(true);
  expect(result.counts).toEqual([0, 1, 0]);
});

test("requires setupWorld or an explicit world before constructing physics", async ({
  page,
}) => {
  await routeGLTS(page, "**/body.glts", physical);
  await page.goto("/test-harness.html");
  const message = await page.evaluate(async () => {
    const loader = new window.GLTSLoader(new window.LoadingManager());
    try {
      await loader.loadAsync("/body.glts");
      return "unexpected success";
    } catch (error) {
      return String(window.readErrorField(error, "cause") ?? error);
    } finally {
      loader.dispose();
    }
  });
  expect(message).toContain("setupWorld");
});

test("owns cloned groups and remaps their joints", async ({ page }) => {
  await routeGLTS(
    page,
    "**/cloned.glts",
    `
    import { scene } from "@drawcall/glts";
    import { clone, RigidBody, RevoluteJoint, Joint } from "@drawcall/physics";
    import { Group } from "three";
    const assembly = new Group();
    const frame = new RigidBody({ type: "static" });
    const door = new RigidBody();
    const hinge = new RevoluteJoint({ body0: frame, body1: door });
    assembly.add(frame, door, hinge);
    const cloned = clone(assembly);
    const clonedJoint = cloned.children[2];
    if (!(clonedJoint instanceof Joint) || clonedJoint.options.body1 !== cloned.children[1]) {
      throw new Error("Cloned joint was not remapped");
    }
    if (!(cloned.children[0] instanceof RigidBody)) throw new Error("Cloned constructor identity was lost");
    scene.add(assembly);
  `,
  );
  await page.goto("/test-harness.html");
  const counts = await page.evaluate(async () => {
    const { AuthoringWorld } = await window.physicsModule();
    const world = new AuthoringWorld();
    const loader = new window.GLTSLoader(new window.LoadingManager(), {
      physicsWorld: world,
    });
    const asset = await loader.loadAsync("/cloned.glts");
    const before = world.objects.size;
    asset.dispose();
    const after = world.objects.size;
    loader.dispose();
    world.dispose();
    return [before, after];
  });
  expect(counts).toEqual([6, 0]);
});
