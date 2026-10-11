import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, expect, it, vi, type MockInstance } from "vitest";

import { glts } from "../../src/vite/index.js";
import { writeFiles } from "./fixture.js";

const temp = await mkdtemp(join(tmpdir(), "glts-dev-"));
const script = join(temp, "public/scene.glts");
let server: ViteDevServer;
let sent: MockInstance<ViteDevServer["environments"]["client"]["hot"]["send"]>;

beforeAll(async () => {
  await writeFiles(temp, {
    "package.json": JSON.stringify({ type: "module", dependencies: { x: "1.0.0" } }),
    "node_modules/x/package.json": JSON.stringify({ name: "x", type: "module", main: "index.js" }),
    "node_modules/x/index.js": `export const marker = {};`,
    "public/scene.glts": `import { marker } from "x";`,
  });
  server = await createServer({
    configFile: false,
    logLevel: "silent",
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

async function edit(source: string): Promise<void> {
  sent.mockClear();
  await writeFile(script, source);
  server.watcher.emit("change", script);
  await vi.waitFor(() => expect(sent).toHaveBeenCalled());
}

it("reloads an edited script in place", async () => {
  await edit(`import { marker } from "x";\nconsole.log(marker);`);
  expect(sent).toHaveBeenCalledWith("glts:update", { url: "/scene.glts" });
});

it("reloads the page when a script's imports change", async () => {
  await edit(`import { marker } from "x";\nimport "z";`);
  expect(sent).toHaveBeenCalledWith({ type: "full-reload" });
});
