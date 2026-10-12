import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger, createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, expect, it, vi, type MockInstance } from "vitest";

import { glts } from "../../src/vite/index.js";
import { writeFiles } from "./fixture.js";

const temp = await mkdtemp(join(tmpdir(), "glts-dev-"));
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
  });
  server = await createServer({
    configFile: false,
    customLogger: logger,
    root: temp,
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

/** Edits a public script and waits until the server sends `payload`. */
async function edit(name: string, source: string, ...payload: unknown[]): Promise<void> {
  sent.mockClear();
  const script = join(temp, "public", name);
  await writeFile(script, source);
  server.watcher.emit("change", script);
  await vi.waitFor(() => expect(sent).toHaveBeenCalledWith(...payload));
}

it("reloads an edited script in place", async () => {
  await edit("scene.glts", `import { marker } from "x";\nconsole.log(marker);`, "glts:update", { url: "/scene.glts" });
});

it("reloads the page when a script's imports change", async () => {
  await edit("scene.glts", `import { marker } from "x";\nimport "z";`, { type: "full-reload" });
});

// scene.glts always imports x too, so these edits keep the scripts' imports.
it("logs type errors until they are fixed", async () => {
  const reload = ["glts:update", { url: "/typed.glts" }];
  await edit("typed.glts", `import { marker } from "x";\nconst size: number = marker;`, ...reload);
  await vi.waitFor(() => expect(logger.error).toHaveBeenCalledWith(
    expect.stringContaining("typed.glts:2:7 - error TS2322"), expect.anything()));
  await edit("typed.glts", `import { marker } from "x";\nconst size: object = marker;`, ...reload);
  await vi.waitFor(() => expect(logger.info).toHaveBeenCalledWith("glts: type errors fixed", expect.anything()));
});
