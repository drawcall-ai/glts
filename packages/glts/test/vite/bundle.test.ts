import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build, type Rolldown } from "vite";
import { expect, it } from "vitest";

import { writeFiles } from "./fixture.js";

it("bundles the loader into a Vite app build, keeping the compiler out of the entry chunk", async () => {
  const root = await mkdtemp(join(tmpdir(), "glts-bundle-"));
  const loader = fileURLToPath(new URL("../../src/index.ts", import.meta.url));
  try {
    await writeFiles(root, {
      "index.html": `<script type="module" src="./main.js"></script>`,
      "main.js": `import { GLTSLoader } from ${JSON.stringify(loader)}; console.log(GLTSLoader);`,
    });
    const result = await build({ root, logLevel: "silent", build: { outDir: join(root, "dist") } });
    if (!("output" in result)) throw new Error("Expected one build output");
    const chunks = result.output.filter((file) => file.type === "chunk");
    const babel = (chunk: Rolldown.OutputChunk): boolean => chunk.moduleIds.some((id) => id.includes("/@babel/"));
    // Precompiled scripts never load the compiler, so it must stay behind the loader's dynamic import.
    expect(chunks.filter((chunk) => chunk.isEntry).some(babel)).toBe(false);
    expect(chunks.some((chunk) => chunk.isDynamicEntry && babel(chunk))).toBe(true);
  } finally {
    await rm(root, { recursive: true });
  }
});
