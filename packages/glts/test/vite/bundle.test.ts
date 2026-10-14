import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { expect, it } from "vitest";

import { writeFiles } from "./fixture.js";

it("bundles the loader into a Vite app, whose build wraps its dynamic imports", async () => {
  const root = await mkdtemp(join(tmpdir(), "glts-bundle-"));
  const loader = fileURLToPath(new URL("../../src/index.ts", import.meta.url));
  try {
    await writeFiles(root, {
      "index.html": `<script type="module" src="./main.js"></script>`,
      "main.js": `import { GLTSLoader } from ${JSON.stringify(loader)}; console.log(GLTSLoader);`,
    });
    await expect(build({ root, logLevel: "silent", build: { outDir: join(root, "dist") } })).resolves.toBeDefined();
  } finally {
    await rm(root, { recursive: true });
  }
});
