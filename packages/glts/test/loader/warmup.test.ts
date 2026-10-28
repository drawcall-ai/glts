import { expect, it } from "vitest";

import { warmup } from "../../src/loader/warmup.js";
import type { GLTSScene } from "../../src/types.js";
import { base, deferred, serve } from "./fixture.js";

it("starts every initial script together and gives shared consumers independent, serialized scenes", async () => {
  const started = new Set<string>();
  const allStarted = deferred();
  const scenes: GLTSScene[] = [];
  const disposed: string[] = [];
  let sharedRuns = 0;
  let sharedActive = 0;
  let mostSharedActive = 0;
  const library = {
    async start(name: string): Promise<number> {
      started.add(name);
      if (started.size === 4) allStarted.resolve();
      const id = name === "shared" ? ++sharedRuns : 1;
      if (name === "shared") mostSharedActive = Math.max(mostSharedActive, ++sharedActive);
      await allStarted.promise;
      return id;
    },
    finish(name: string, scene: GLTSScene): void {
      if (name === "shared") sharedActive--;
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
  expect(mostSharedActive).toBe(1);
  const parents = scenes.filter((scene) => scene.name === "a1" || scene.name === "b1");
  expect(parents).toHaveLength(2);
  expect(new Set(parents.flatMap((scene) => scene.children))).toHaveLength(2);
  expect(disposed).toEqual([]);
  loader.dispose();
  expect(disposed.sort()).toEqual(["a1", "b1", "shared1", "shared2", "unused1"]);
});

it("warms the ordinary scene before running the requested instance count", async () => {
  const counts: number[] = [];
  const loader = serve({
    "parent.glts": `
      import { gltsLoader, scene } from "@drawcall/glts";
      const child = await gltsLoader.loadInstancesAsync("./child.glts", 3);
      if (child.count !== 3) throw new Error("Wrong instance count");
      scene.add(child);
    `,
    "child.glts": `
      import { instanceCount, onMatrixUpdateAt } from "@drawcall/glts";
      import { record } from "library";
      record(instanceCount);
      onMatrixUpdateAt(() => {});
    `,
  }, { record: (count: number) => counts.push(count) });

  await warmup(loader, [base + "parent.glts", base + "child.glts"]);
  expect(counts).toEqual([1, 3]);
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

it("rejects a cycle between concurrently started initial scripts", async () => {
  const loader = serve({
    "a.glts": `import { gltsLoader, scene } from "@drawcall/glts"; scene.add(await gltsLoader.loadAsync("./b.glts"));`,
    "b.glts": `import { gltsLoader, scene } from "@drawcall/glts"; scene.add(await gltsLoader.loadAsync("./a.glts"));`,
  });
  await expect(warmup(loader, [base + "a.glts", base + "b.glts"]))
    .rejects.toThrow("GLTS build warmup failed");
}, 2_000);

it.each(["before", "after"])("rejects cycles added %s a rerun is queued, without running it", async (order) => {
  const firstClaimed = deferred();
  const dependencyAdded = deferred();
  let bRuns = 0;
  const loader = serve({
    "a.glts": `
      import { gltsLoader, scene } from "@drawcall/glts";
      import { claimed, added, add } from "library";
      await claimed;
      ${order === "before" ? "await added;" : ""}
      const child = gltsLoader.loadAsync("./b.glts");
      ${order === "after" ? "add();" : ""}
      scene.add(await child);
    `,
    "b.glts": `
      import { gltsLoader, scene } from "@drawcall/glts";
      import { started, claimed, added, add } from "library";
      started();
      await claimed;
      ${order === "after" ? "await added;" : ""}
      const child = gltsLoader.loadAsync("./a.glts");
      ${order === "before" ? "add();" : ""}
      scene.add(await child);
    `,
    "claim.glts": `
      import { gltsLoader, scene } from "@drawcall/glts";
      import { claim } from "library";
      const child = gltsLoader.loadAsync("./b.glts");
      claim();
      scene.add(await child);
    `,
  }, {
    claim: firstClaimed.resolve, claimed: firstClaimed.promise,
    add: dependencyAdded.resolve, added: dependencyAdded.promise,
    started: () => { bRuns++; },
  });
  await expect(warmup(loader, [base + "a.glts", base + "b.glts", base + "claim.glts"]))
    .rejects.toThrow("GLTS build warmup failed");
  expect(bRuns).toBe(1);
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
