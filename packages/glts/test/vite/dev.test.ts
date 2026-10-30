import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger, createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, expect, it, vi, type MockInstance } from "vitest";

import { glts } from "../../src/vite/index.js";
import { Linker } from "../../src/linker/index.js";
import { precompiledPrefix } from "../../src/linker/precompiled.js";
import { writeFiles } from "./fixture.js";

const temp = await mkdtemp(join(tmpdir(), "glts-dev-"));
// The server's type check blocks its event loop for seconds on slow machines.
const checked = { timeout: 15_000 };
let server: ViteDevServer;
let sent: MockInstance<ViteDevServer["environments"]["client"]["hot"]["send"]>;
const logger = createLogger("silent");
vi.spyOn(logger, "error");
vi.spyOn(logger, "info");

beforeAll(async () => {
  await writeFiles(temp, {
    "package.json": JSON.stringify({ type: "module", dependencies: { x: "1.0.0" } }),
    "node_modules/x/package.json": JSON.stringify({ name: "x", type: "module", main: "index.js" }),
    "node_modules/x/index.js": `export const marker = {};`,
    "node_modules/x/index.d.ts": `export declare const marker: object;`,
    "public/scene.glts": `import { marker } from "x";`,
    "public/typed.glts": `import { marker } from "x";`,
    "public/helped.glts": `import { value } from "./helper.ts"; import "x"; console.log(value);`,
    "public/helper.ts": `export const value = 1;`,
    "src/app.ts": `export const app: number = 1;`,
  });
  server = await createServer({
    configFile: false,
    customLogger: logger,
    root: temp,
    base: "/app/",
    plugins: [glts()],
    server: { port: 0 },
  });
  // The dependency optimizer only settles, and lets the server close, once it listens.
  await server.listen();
  sent = vi.spyOn(server.environments.client.hot, "send");
  await server.environments.client.transformRequest("virtual:glts-modules");
});

afterAll(async () => {
  await server.close();
  await rm(temp, { recursive: true });
});

/** Edits a public file and waits until the server sends `payload`. */
async function edit(name: string, source: string, ...payload: unknown[]): Promise<void> {
  await write("change", name, source, ...payload);
}

/** Writes a public file, emits `event` for it, and waits until the server sends `payload`. */
async function write(event: "add" | "change", name: string, source: string, ...payload: unknown[]): Promise<void> {
  sent.mockClear();
  const file = join(temp, "public", name);
  await writeFile(file, source);
  server.watcher.emit(event, file);
  await vi.waitFor(() => expect(sent).toHaveBeenCalledWith(...payload), checked);
}

function served(path: string): URL {
  const url = server.resolvedUrls?.local[0];
  if (!url) throw new Error("Development server has no URL");
  return new URL(path, url);
}

async function source(path: string): Promise<string> {
  const response = await fetch(served(path));
  expect(response.ok).toBe(true);
  return response.text();
}

it("serves precompiled scripts and helpers at their public URLs, including query variants", async () => {
  const script = await source("scene.glts?variant=1");
  expect(script.startsWith(precompiledPrefix)).toBe(true);
  expect(script).toContain("export default");
  expect(await source("scene.glts?variant=2")).toBe(script);
  expect(await source("helper.ts")).toBe(precompiledPrefix + "export const value = 1;");
});

it("leaves malformed escapes in other requests to Vite", async () => {
  const response = await fetch(served("/app/%E0%A4%A.png"));
  expect(response.status).toBe(404);
});

it("reloads an edited script in place", async () => {
  await edit("scene.glts", `import { marker } from "x";\nconsole.log(marker);`, "glts:reload", { url: "/app/scene.glts" });
});

it("reloads the scripts importing an edited helper", async () => {
  await edit("helper.ts", `export const value = 2;`, "glts:reload", { url: "/app/helper.ts" });
  expect(await source("helper.ts")).toBe(precompiledPrefix + "export const value = 2;");
});

it("reloads the scripts importing a created helper", async () => {
  await write("add", "created.ts", `export const value = 1;`, "glts:reload", { url: "/app/created.ts" });
});

it("reloads the page when a helper's imports change", async () => {
  await edit("helper.ts", `import "y";\nexport const value = 3;`, { type: "full-reload" });
});

it("reloads the page when a script's imports change", async () => {
  await edit("scene.glts", `import { marker } from "x";\nimport "z";`, { type: "full-reload" });
});

// scene.glts always imports x too, so these edits keep the scripts' imports.
it("logs type errors until they are fixed", async () => {
  const reload = ["glts:reload", { url: "/app/typed.glts" }];
  await edit("typed.glts", `import { marker } from "x";\nconst size: number = marker;`, ...reload);
  await vi.waitFor(() => expect(logger.error).toHaveBeenCalledWith(
    expect.stringContaining("typed.glts:2:7 - error TS2322"), expect.anything()), checked);
  await edit("typed.glts", `import { marker } from "x";\nconst size: object = marker;`, ...reload);
  await vi.waitFor(() => expect(logger.info).toHaveBeenCalledWith("glts: type errors fixed", expect.anything()), checked);
});

// Last: the broken script keeps the type check failing.
it("serves a script that does not compile as source, so its load reports the error, and keeps serving app modules", async () => {
  await write("add", "broken.glts", "const = 1;", "glts:reload", { url: "/app/broken.glts" });
  expect(await source("src/app.ts")).toContain("app");
  expect(await source("broken.glts")).toBe("const = 1;");
  const linker = new Linker({ cdnURL: new URL("https://cdn.test/"), modules: {}, fetch });
  try {
    await expect(linker.getScript(served("broken.glts").href)).rejects.toMatchObject({
      phase: "transform",
      cause: expect.objectContaining({ message: expect.stringContaining("(1:6)") }),
    });
  } finally {
    linker.dispose();
  }
});
