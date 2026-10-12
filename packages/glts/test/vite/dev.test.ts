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
    "node_modules/x/index.d.ts": `export declare const marker: object;`,
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

/** Edits the script and waits until the server sends `payload`. */
async function edit(source: string, ...payload: unknown[]): Promise<void> {
  sent.mockClear();
  await writeFile(script, source);
  server.watcher.emit("change", script);
  await vi.waitFor(() => expect(sent).toHaveBeenCalledWith(...payload));
}

it("reloads an edited script in place", async () => {
  await edit(`import { marker } from "x";\nconsole.log(marker);`, "glts:update", { url: "/scene.glts" });
});

it("reloads the page when a script's imports change", async () => {
  await edit(`import { marker } from "x";\nimport "z";`, { type: "full-reload" });
});

/** A connected page's HMR socket and the messages it received. */
async function connect(): Promise<{ socket: WebSocket; received: unknown[] }> {
  const url = new URL(server.resolvedUrls?.local[0] ?? "");
  url.protocol = "ws:";
  url.searchParams.set("token", server.config.webSocketToken);
  const socket = new WebSocket(url, "vite-hmr");
  const received: unknown[] = [];
  socket.addEventListener("message", ({ data }) => received.push(JSON.parse(String(data))));
  await new Promise((resolve) => socket.addEventListener("open", resolve));
  return { socket, received };
}

it("reports type errors in the overlay, also of pages opened later, until they are fixed", async () => {
  const first = await connect();
  const error = expect.objectContaining({
    type: "error",
    err: expect.objectContaining({ message: expect.stringContaining("scene.glts:2:7 - error TS2322"), plugin: "glts" }),
  });
  await edit(`import { marker } from "x";\nconst size: number = marker;`, error);

  const later = await connect();
  later.socket.send(JSON.stringify({ type: "custom", event: "glts:ready" }));
  await vi.waitFor(() => expect(later.received).toContainEqual(error));
  first.socket.close();
  later.socket.close();

  await edit(`import { marker } from "x";\nconst size: object = marker;`, "glts:fixed");
});
