import { describe, expect, it } from "vitest";

import { GLTSError } from "./errors.js";
import { rewriteModule } from "./rewrite-module.js";

describe("rewriteModule", () => {
  it("rewrites static specifiers and import.meta.url", async () => {
    const sourceURL = "https://example.test/assets/tree.glts";
    const transformed = await rewriteModule({
      source: `
        import * as THREE from "three";
        import Branch from "./branch.glts";
        export const assetURL = new URL("./leaf.png", import.meta.url);
        export { THREE, Branch };
      `,
      sourceURL,
      importChain: [sourceURL],
      resolveImport: async (specifier) => `blob:${specifier}`
    });

    expect(transformed).toContain('from "blob:three"');
    expect(transformed).toContain('from "blob:./branch.glts"');
    expect(transformed).toContain(`new URL("./leaf.png", ${JSON.stringify(sourceURL)})`);
    expect(transformed).toContain(`//# sourceURL=${sourceURL}`);
  });

  it("rejects dynamic imports with source context", async () => {
    const sourceURL = "https://example.test/assets/tree.glts";
    const operation = rewriteModule({
      source: 'const child = await import("./branch.glts")',
      sourceURL,
      importChain: [sourceURL],
      resolveImport: async (specifier) => specifier
    });

    await expect(operation).rejects.toBeInstanceOf(GLTSError);
    await expect(operation).rejects.toThrow("Dynamic and source-phase imports are not supported");
  });
});
