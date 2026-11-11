import { expect, it } from "vitest";

import { warmup } from "../../src/loader/warmup.js";
import type { GLTSScene } from "../../src/types.js";
import { base, deferred, serve } from "./fixture.js";

it("runs initial scripts one after another and gives shared consumers independent, serialized scenes", async () => {
  const scenes: GLTSScene[] = [];
  const disposed: string[] = [];
  let sharedRuns = 0;
  let active = 0;
  let mostActive = 0;
  const library = {
    async start(name: string): Promise<number> {
      if (name !== "shared") mostActive = Math.max(mostActive, ++active);
      await Promise.resolve();
      return name === "shared" ? ++sharedRuns : 1;
    },
    finish(name: string, scene: GLTSScene): void {
      if (name !== "shared") active--;
      scenes.push(scene);
    },
    dispose(name: string): void { disposed.push(name); },
  };
  const source = (name: string, nested = false): string => `
    import { gltsLoader, scene, onDispose } from "@drawcall/glts";
    import { start, finish, dispose } from "library";
    const id = await start(${JSON.stringify(name)});
    scene.name = ${JSON.stringify(name)} + id;
    onDispose(() => dispose(scene.name));
    ${nested ? `scene.add(await gltsLoader.loadAsync("./shared.glts"));` : ""}
    finish(${JSON.stringify(name)}, scene);
  `;
  const loader = serve({
    "a.glts": source("a", true),
    "b.glts": source("b", true),
    "shared.glts": source("shared"),
    "unused.glts": source("unused"),
  }, library);

  await warmup(loader, ["a.glts", "b.glts", "shared.glts", "unused.glts"].map((file) => base + file));

  expect(sharedRuns).toBe(2);
  expect(mostActive).toBe(1);
  const parents = scenes.filter((scene) => scene.name === "a1" || scene.name === "b1");
  expect(parents).toHaveLength(2);
  expect(new Set(parents.flatMap((scene) => scene.children))).toHaveLength(2);
  expect(disposed).toEqual([]);
  loader.dispose();
  expect(disposed.sort()).toEqual(["a1", "b1", "shared1", "shared2", "unused1"]);
});

it("warms the ordinary scene before running the requested instances", async () => {
  const runs: string[] = [];
  const loader = serve({
    "parent.glts": `
      import { gltsLoader, scene } from "@drawcall/glts";
      import { record } from "library";
      const child = await gltsLoader.loadInstancesAsync("./child.glts", 3);
      record("instances " + child.count);
      scene.add(child);
    `,
    "child.glts": `
      import * as THREE from "three";
      import { scene } from "@drawcall/glts";
      import { record } from "library";
      record("child");
      scene.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial()));
    `,
  }, { record: (run: string) => runs.push(run) });

  await warmup(loader, [base + "parent.glts", base + "child.glts"]);
  expect(runs).toEqual(["child", "child", "instances 3"]);
});

it("runs undiscovered nested scripts and waits for unawaited loads before finishing", async () => {
  const childStarted = deferred();
  const finishChild = deferred();
  let finished = false;
  const loader = serve({
    "parent.glts": `
      import { gltsLoader, scene } from "@drawcall/glts";
      void gltsLoader.loadAsync("./child.glts").then(child => scene.add(child));
    `,
    "child.glts": `
      import { start, finish } from "library";
      start();
      await finish;
    `,
  }, { start: childStarted.resolve, finish: finishChild.promise });
  const warming = warmup(loader, [base + "parent.glts"]).then(() => { finished = true; });
  await childStarted.promise;
  expect(finished).toBe(false);
  finishChild.resolve();
  await warming;
  expect(finished).toBe(true);
});

it("rejects a cycle between initial scripts", async () => {
  const loader = serve({
    "a.glts": `import { gltsLoader, scene } from "@drawcall/glts"; scene.add(await gltsLoader.loadAsync("./b.glts"));`,
    "b.glts": `import { gltsLoader, scene } from "@drawcall/glts"; scene.add(await gltsLoader.loadAsync("./a.glts"));`,
  });
  await expect(warmup(loader, [base + "a.glts", base + "b.glts"]))
    .rejects.toThrow("Cyclic GLTS warmup dependency");
}, 2_000);

it("rejects a cycle closed by queueing a rerun behind a claimed initial scene", async () => {
  let bRuns = 0;
  const loader = serve({
    "claim.glts": `import { gltsLoader, scene } from "@drawcall/glts"; scene.add(await gltsLoader.loadAsync("./b.glts"));`,
    "a.glts": `import { gltsLoader, scene } from "@drawcall/glts"; scene.add(await gltsLoader.loadAsync("./b.glts"));`,
    "b.glts": `
      import { gltsLoader, scene } from "@drawcall/glts";
      import { started } from "library";
      started();
      scene.add(await gltsLoader.loadAsync("./a.glts"));
    `,
  }, { started: () => { bRuns++; } });
  await expect(warmup(loader, [base + "claim.glts", base + "a.glts", base + "b.glts"]))
    .rejects.toMatchObject({ phase: "resolve", message: expect.stringContaining("Cyclic") });
  expect(bRuns).toBe(1);
}, 2_000);

it("rejects a cycle closed after a rerun was queued behind a claimed initial scene", async () => {
  const queued = deferred();
  let bRuns = 0;
  const loader = serve({
    // Loading both starts both initial scenes before their turns, so a queues its rerun of b before b loads a.
    "claim.glts": `
      import { gltsLoader, scene } from "@drawcall/glts";
      const [b, a] = await Promise.all([gltsLoader.loadAsync("./b.glts"), gltsLoader.loadAsync("./a.glts")]);
      scene.add(b, a);
    `,
    "a.glts": `
      import { gltsLoader, scene } from "@drawcall/glts";
      import { queue } from "library";
      const child = gltsLoader.loadAsync("./b.glts");
      queue();
      scene.add(await child);
    `,
    "b.glts": `
      import { gltsLoader, scene } from "@drawcall/glts";
      import { started, queued } from "library";
      started();
      await queued;
      scene.add(await gltsLoader.loadAsync("./a.glts"));
    `,
  }, { queue: queued.resolve, queued: queued.promise, started: () => { bRuns++; } });
  // The rerun, queued first, runs after the failed initial scene and loads its ancestor again, which fails too.
  const cycle = { phase: "resolve", message: expect.stringContaining("Cyclic") };
  await expect(warmup(loader, [base + "claim.glts", base + "a.glts", base + "b.glts"]))
    .rejects.toMatchObject({ errors: [{ phase: "resolve" }, cycle, cycle] });
  expect(bRuns).toBe(2);
}, 2_000);

it("reports execution failures after the other initial scripts finish", async () => {
  const completed: string[] = [];
  const loader = serve({
    "broken.glts": `throw new Error("warmup exploded");`,
    "other.glts": `import { complete } from "library"; await Promise.resolve(); complete();`,
  }, { complete: () => completed.push("other") });
  await expect(warmup(loader, [base + "broken.glts", base + "other.glts"]))
    .rejects.toThrow("Unable to execute GLTS script");
  expect(completed).toEqual(["other"]);
});

it("runs a queued consumer of a script whose previous run failed", async () => {
  const requested = deferred();
  const runs: string[] = [];
  const loader = serve({
    "a.glts": `
      import { gltsLoader, scene } from "@drawcall/glts";
      import { request } from "library";
      const child = gltsLoader.loadInstancesAsync("./child.glts", 2);
      request();
      scene.add(await child);
    `,
    "b.glts": `
      import { gltsLoader, scene } from "@drawcall/glts";
      import { requested } from "library";
      await requested;
      scene.add(await gltsLoader.loadAsync("./child.glts"));
    `,
    "child.glts": `
      import { record } from "library";
      record("child");
    `,
  }, { request: requested.resolve, requested: requested.promise, record: (run: string) => runs.push(run) });

  // An empty scene has nothing to instance.
  await expect(warmup(loader, [base + "a.glts", base + "b.glts"]))
    .rejects.toMatchObject({ url: base + "child.glts", message: expect.stringContaining("at least one mesh") });
  expect(runs).toEqual(["child", "child"]);
});

it("reports a failure shared by several scripts once", async () => {
  const loader = serve({
    "parent.glts": `import { gltsLoader, scene } from "@drawcall/glts"; scene.add(await gltsLoader.loadAsync("./child.glts"));`,
    "child.glts": `throw new Error("child exploded");`,
    "other.glts": `throw new Error("other exploded");`,
  });
  const warming = warmup(loader, [base + "parent.glts", base + "child.glts", base + "other.glts"]);
  await expect(warming).rejects.toThrow("GLTS build warmup failed");
  await expect(warming).rejects.toMatchObject({
    errors: [{ cause: { message: "child exploded" } }, { cause: { message: "other exploded" } }],
  });
});
