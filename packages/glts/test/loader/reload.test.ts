import { Group, InstancedMesh } from "three";
import { expect, it, vi } from "vitest";

import type { GLTSScene } from "../../src/types.js";
import { base, serve } from "./fixture.js";

const url = `${base}scene.glts`;

function errorCauses(error: unknown): unknown[] {
  const causes: unknown[] = [error];
  if (error instanceof AggregateError) causes.push(...error.errors.flatMap(errorCauses));
  if (error instanceof Error && error.cause !== undefined) causes.push(...errorCauses(error.cause));
  return causes;
}

it("shares a helper between scripts and, when it changes, relinks the helpers importing it and reloads both", async () => {
  const script = `import { scene } from "@drawcall/glts"; import { registry, value } from "./outer.ts";
    scene.userData = { registry, value };`;
  const sources = {
    "a.glts": script,
    "b.glts": script,
    "outer.ts": `export { value } from "./inner.ts"; export const registry = {};`,
    "inner.ts": `export const value = 1;`,
  };
  const loader = serve(sources);
  const [a, b] = await Promise.all([loader.loadAsync(`${base}a.glts`), loader.loadAsync(`${base}b.glts`)]);
  const { registry } = a.userData;
  expect(b.userData.registry).toBe(registry);
  sources["inner.ts"] = `export const value = 2;`;
  await loader.reload(`${base}inner.ts`);
  expect([a.userData.value, b.userData.value]).toEqual([2, 2]);
  expect(b.userData.registry).toBe(a.userData.registry);
  expect(a.userData.registry).not.toBe(registry);
});

it("cleans up the replacement when the previous execution's cleanup disposes the node", async () => {
  const previousFailure = new Error("Previous cleanup failed");
  const nextFailure = new Error("Replacement cleanup failed");
  const disposePrevious = vi.fn((scene: GLTSScene) => {
    scene.add(new Group());
    scene.dispose();
    throw previousFailure;
  });
  const disposeNext = vi.fn(() => { throw nextFailure; });
  const sources = {
    "scene.glts": `import { onDispose, scene } from "@drawcall/glts";
      import { disposePrevious } from "library"; onDispose(() => disposePrevious(scene));`,
  };
  const loader = serve(sources, { disposePrevious, disposeNext });
  const node = await loader.loadAsync(url);
  sources["scene.glts"] = `import { onDispose, scene } from "@drawcall/glts";
    import { disposeNext } from "library"; scene.name = "replacement"; onDispose(disposeNext);`;

  const causes = errorCauses(await loader.reload(url).catch((error: unknown) => error));
  expect(causes).toContain(previousFailure);
  expect(causes).toContain(nextFailure);
  expect(causes.some((error) => error instanceof Error && error.message.includes("GLTS node was disposed during reload"))).toBe(true);
  expect(disposePrevious).toHaveBeenCalledTimes(1);
  expect(disposeNext).toHaveBeenCalledTimes(1);
  expect(node.name).not.toBe("replacement");
  expect(node.children).toHaveLength(0);
  expect(() => node.update(0)).toThrow("disposed");
});

it("disposes automatic instance resources once when execution cleanup reenters the node", async () => {
  const loader = serve({
    "scene.glts": `import * as THREE from "three";
      import { onDispose, scene } from "@drawcall/glts";
      scene.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial()));
      onDispose(() => scene.dispose());`,
  });
  const node = await loader.loadInstancesAsync(url, 2);
  const disposed = vi.fn();
  node.traverse((object) => {
    if (object instanceof InstancedMesh) object.addEventListener("dispose", disposed);
  });
  const failure = await loader.reload(url).catch((error: unknown) => error);
  expect(errorCauses(failure).some((error) =>
    error instanceof Error && error.message.includes("disposed during reload"))).toBe(true);
  expect(disposed).toHaveBeenCalledTimes(1);
});

it("runs the previous execution's disposal callbacks with its children still attached", async () => {
  const seen: string[] = [];
  const source = (name: string): string => `import * as THREE from "three";
    import { onDispose, scene } from "@drawcall/glts";
    import { see } from "library";
    scene.add(Object.assign(new THREE.Group(), { name: "${name}" }));
    onDispose(() => scene.traverse((object) => { if (object !== scene) see(object.name); }));`;
  const sources = { "scene.glts": source("previous") };
  const loader = serve(sources, { see: (name: string) => { seen.push(name); } });
  const node = await loader.loadAsync(url);
  sources["scene.glts"] = source("next");
  await loader.reload(url);
  expect(seen).toEqual(["previous"]);
  expect(node.children.map(({ name }) => name)).toEqual(["next"]);
});

it("rejects a cycle that reloading a nested script introduces", async () => {
  const load = (path: string): string => `import { gltsLoader, scene } from "@drawcall/glts";
    scene.add(await gltsLoader.loadAsync("${path}"));`;
  const sources = { "parent.glts": load("./child.glts"), "child.glts": "" };
  const loader = serve(sources);
  await loader.loadAsync(`${base}parent.glts`);
  sources["child.glts"] = load("./parent.glts");
  await expect(loader.reload(`${base}child.glts`)).rejects.toMatchObject({
    phase: "resolve",
    importChain: [`${base}parent.glts`, `${base}child.glts`, `${base}parent.glts`],
  });
});

it("reloads a redirected script by the URL it was fetched from", async () => {
  const fetched = `${base}redirected/scene.glts`;
  let version = 1;
  const loader = serve({});
  vi.stubGlobal("fetch", async () => {
    const response = new Response(`import { scene } from "@drawcall/glts"; scene.userData.version = ${version};`);
    Object.defineProperty(response, "url", { value: fetched });
    return response;
  });
  const node = await loader.loadAsync(`${base}original.glts`);
  version = 2;
  await loader.reload(fetched);
  expect(node.userData.version).toBe(2);
});
