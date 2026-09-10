import { describe, expect, it } from "vitest";

import { GLTSError } from "../../src/errors.js";
import { rewriteModule } from "../../src/modules/rewrite.js";

describe("rewriteModule", () => {
  it("rewrites static specifiers and initializes import.meta.url", async () => {
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
    expect(transformed).toContain(`import.meta.url = ${JSON.stringify(sourceURL)};`);
    expect(transformed).toContain('new URL("./leaf.png", import.meta.url)');
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


it("preserves native import.meta identity, property syntax and mutations", async () => {
  const sourceURL = "https://example.test/meta.glts";
  const source = `
    const meta = import.meta;
    const { url } = import.meta;
    export const initial = [
      url, import.meta.url, import.meta["url"], import.meta /* comment */ . url
    ];
    export const same = meta === import.meta;
    export const prototype = Object.getPrototypeOf(meta);
    export const suffix = import.meta.urlSuffix;
    import.meta.url = "changed";
    export const updated = meta.url;
  `;
  const transformed = await rewriteModule({
    source,
    sourceURL,
    importChain: [sourceURL],
    resolveImport: async (specifier) => specifier,
  });
  const module: unknown = await import(`data:text/javascript,${encodeURIComponent(transformed)}`);
  expect(module).toMatchObject({
    initial: Array(4).fill(sourceURL),
    same: true,
    prototype: null,
    suffix: undefined,
    updated: "changed",
  });
});

it.each(["\n", "\r", "\r\n", "\u2028", "\u2029"])("keeps a hashbang first with line separator %j", async (separator) => {
  const sourceURL = "https://example.test/hashbang.glts";
  const transformed = await rewriteModule({
    source: `#!/usr/bin/env node${separator}export const url = import.meta.url;`,
    sourceURL,
    importChain: [sourceURL],
    resolveImport: async (specifier) => specifier,
  });
  expect(transformed.startsWith(`#!/usr/bin/env node${separator}import.meta.url = `)).toBe(true);
  const module: unknown = await import(`data:text/javascript,${encodeURIComponent(transformed)}`);
  expect(module).toMatchObject({ url: sourceURL });
});

it("leaves code without import.meta intact and removes sourceURL line separators", async () => {
  const source = "export const value = 1;";
  const transformed = await rewriteModule({
    source,
    sourceURL: "https://example.test/\n\r\u2028\u2029plain.js",
    importChain: [],
    resolveImport: async (specifier) => specifier,
  });
  expect(transformed).toBe(`${source}\n//# sourceURL=https://example.test/plain.js\n`);
});
