import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
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
