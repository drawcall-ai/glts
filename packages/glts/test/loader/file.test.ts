import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import MagicString from "magic-string";
import { LoadingManager, Mesh } from "three";
import { expect, it } from "vitest";

import { GLTSLoader } from "../../src/loader/index.js";

it("loads scripts, helpers, and nested scripts from disk and reloads them after an edit", async () => {
  const directory = await mkdtemp(join(tmpdir(), "glts-"));
  const write = (name: string, source: string): Promise<void> => writeFile(join(directory, name), source);
  await write("name.ts", 'export const name = "first";');
  await write("child.glts", `
    import * as THREE from "three";
    import { scene } from "@drawcall/glts";
    scene.add(new THREE.Mesh());
  `);
  await write("scene.glts", `
    import { gltsLoader, scene } from "@drawcall/glts";
    import { name } from "./name.ts";
    scene.name = name;
    scene.add(await gltsLoader.loadAsync("./child.glts"));
  `);
  const loader = new GLTSLoader(new LoadingManager());
  try {
    const scene = await loader.loadAsync(pathToFileURL(join(directory, "scene.glts")));
    expect(scene.name).toBe("first");
    expect(scene.children[0]?.children[0]).toBeInstanceOf(Mesh);

    await write("name.ts", 'export const name = "second";');
    await loader.reload(pathToFileURL(join(directory, "name.ts")));
    expect(scene.name).toBe("second");
  } finally {
    loader.dispose();
    await rm(directory, { recursive: true });
  }
});

it("reports a missing file as a fetch failure", async () => {
  const loader = new GLTSLoader(new LoadingManager());
  const url = pathToFileURL(join(tmpdir(), "glts-missing.glts"));
  try {
    await expect(loader.loadAsync(url)).rejects.toMatchObject({ phase: "fetch", url: url.href });
  } finally {
    loader.dispose();
  }
});

it("imports bare specifiers through the host's resolve, sharing its instances, and reports missing ones", async () => {
  const directory = await mkdtemp(join(tmpdir(), "glts-"));
  const url = (name: string): URL => pathToFileURL(join(directory, name));
  await writeFile(url("scene.glts"), `
    import MagicString from "magic-string";
    import { scene } from "@drawcall/glts";
    scene.userData.MagicString = MagicString;
  `);
  await writeFile(url("missing.glts"), 'import "glts-missing-package";');
  const loader = new GLTSLoader(new LoadingManager(), { resolve: import.meta.resolve });
  try {
    expect((await loader.loadAsync(url("scene.glts"))).userData.MagicString).toBe(MagicString);
    await expect(loader.loadAsync(url("missing.glts"))).rejects.toMatchObject({ phase: "resolve" });
  } finally {
    loader.dispose();
    await rm(directory, { recursive: true });
  }
});

it("resolves dynamic imports when they run, like static ones, and tracks the helpers they load", async () => {
  const directory = await mkdtemp(join(tmpdir(), "glts-"));
  const url = (name: string): URL => pathToFileURL(join(directory, name));
  await writeFile(url("name.ts"), 'export const name = "first";');
  await writeFile(url("parent.ts"), 'export { load } from "./child.ts";');
  await writeFile(url("child.ts"), 'export const load = () => import("./parent.ts");');
  await writeFile(url("scene.glts"), `
    import { scene } from "@drawcall/glts";
    import * as parent from "./parent.ts";
    scene.userData.parent = (await parent.load()) === parent;
    const missing = () => import("glts-missing-package");
    scene.name = (await import("./name.ts")).name;
    scene.userData.MagicString = (await import("magic-" + "string")).default;
    scene.userData.context = await import("@drawcall/glts").then(() => "", (error) => error.cause.message);
    scene.userData.load = () => import("./name.ts");
    scene.userData.missing = await import("./missing.ts").then(() => "", (error) => error.message);
  `);
  const loader = new GLTSLoader(new LoadingManager(), { resolve: import.meta.resolve });
  try {
    const scene = await loader.loadAsync(url("scene.glts"));
    expect(scene.name).toBe("first");
    expect(scene.userData.parent).toBe(true);
    expect(scene.userData.missing).toContain(`[GLTS:resolve] Unable to import ./missing.ts\nURL: ${url("scene.glts").href}`);
    expect(scene.userData.MagicString).toBe(MagicString);
    expect(scene.userData.context).toContain("Dynamic imports cannot bind @drawcall/glts");

    await writeFile(url("name.ts"), 'export const name = "second";');
    await loader.reload(url("name.ts"));
    expect(scene.name).toBe("second");

    const load: unknown = scene.userData.load;
    if (typeof load !== "function") throw new Error("The script did not store its loader");
    loader.dispose();
    await expect(load()).rejects.toThrow("The GLTS loader of this module has been disposed");
  } finally {
    loader.dispose();
    await rm(directory, { recursive: true });
  }
});
