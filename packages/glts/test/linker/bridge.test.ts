import { afterEach, expect, it, vi } from "vitest";

import { Linker } from "../../src/linker/index.js";
import { precompiledPrefix } from "../../src/linker/precompiled.js";

// Node.js cannot import blob: URLs, so these tests run the linker as a browser would.
vi.mock(import("../../src/urls.js"), async (importOriginal) => ({ ...await importOriginal(), importsBlobs: () => true }));

const url = "https://assets.test/scene.glts";
const source = `${precompiledPrefix}export default () => {};`;
let linker: Linker | undefined;

afterEach(() => {
  linker?.dispose();
  vi.restoreAllMocks();
});

function browserLinker(fetch: () => Promise<Response>): Linker {
  linker = new Linker({ cdnURL: new URL("https://cdn.test/"), modules: {}, fetch });
  return linker;
}

it("keeps browser module URLs through invalidation and releases them when the loader is disposed", async () => {
  const allocated: string[] = [];
  const create = URL.createObjectURL;
  vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
    const url = create(blob);
    allocated.push(url);
    return url;
  });
  const linker = browserLinker(async () => new Response(source));
  const first = await linker.getScript(url);
  linker.invalidate(url);
  const next = await linker.getScript(url);
  expect(first.module).not.toBe(next.module);
  expect(first.module).toMatch(/^blob:/);
  expect((await fetch(first.module)).ok).toBe(true);
  expect((await fetch(next.module)).ok).toBe(true);
  linker.dispose();
  for (const url of allocated) await expect(fetch(url)).rejects.toThrow();
});

it("does not allocate a browser module when an in-flight source fetch finishes after disposal", async () => {
  let finish = (_response: Response): void => { throw new Error("Missing pending fetch"); };
  const pending = new Promise<Response>((resolve) => { finish = resolve; });
  const linker = browserLinker(() => pending);
  const created = vi.spyOn(URL, "createObjectURL");
  const linking = linker.getScript(url);
  linker.dispose();
  finish(new Response(source));
  await expect(linking).rejects.toThrow("The GLTS loader of this module has been disposed");
  expect(created).not.toHaveBeenCalled();
});
