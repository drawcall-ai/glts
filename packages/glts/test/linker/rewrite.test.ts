import { describe, expect, it } from "vitest";

import { GLTSError } from "../../src/errors.js";
import { rewriteModule } from "../../src/linker/rewrite.js";

describe("rewriteModule", () => {
  it("quotes linked data URLs safely inside single-quoted imports", async () => {
    const linked = `data:text/javascript,export const name = 'dragon';`;
    const transformed = await rewriteModule({ source: "import { name } from 'asset'; export { name };", url: "file:///dragon.glts" }, [], async () => linked, "load");
    const result: unknown = await import(`data:text/javascript,${encodeURIComponent(transformed)}`);
    expect(result).toMatchObject({ name: "dragon" });
  });
  it("rewrites static specifiers and initializes import.meta.url", async () => {
    const sourceURL = "https://example.test/assets/tree.glts";
    const transformed = await rewriteModule({
      source: `
        import * as THREE from "three";
        import Branch from "./branch.glts";
        export const assetURL = new URL("./leaf.png", import.meta.url);
        export { THREE, Branch };
      `,
      url: sourceURL
    }, [sourceURL], async (specifier) => `blob:${specifier}`, "load");

    expect(transformed).toContain('from "blob:three"');
    expect(transformed).toContain('from "blob:./branch.glts"');
    expect(transformed).toContain(`import.meta.url = ${JSON.stringify(sourceURL)};`);
    expect(transformed).toContain('new URL("./leaf.png", import.meta.url)');
    expect(transformed).toContain(`//# sourceURL=${sourceURL}`);
  });

  it("replaces the keyword of literal and computed dynamic imports, resolving nothing up front", async () => {
    const sourceURL = "https://example.test/assets/tree.glts";
    const resolved: string[] = [];
    const transformed = await rewriteModule({
      source: 'import "three"; const a = () => import("rclnodejs"); const b = (name) => import (name);',
      url: sourceURL
    }, [sourceURL], async (specifier) => { resolved.push(specifier); return specifier; }, "load");

    expect(resolved).toEqual(["three"]);
    expect(transformed.startsWith("const __glts_import = load;\n")).toBe(true);
    expect(transformed).toContain('const a = () => __glts_import("rclnodejs");');
    expect(transformed).toContain("const b = (name) => __glts_import (name);");
  });

  it("keeps a dynamic import its own statement, also at the start, in code without semicolons", async () => {
    const transformed = await rewriteModule({
      source: 'import("x").catch(() => {})\nexport const f = 1\nimport("x").catch(() => {})',
      url: "https://example.test/asi.js"
    }, [], async (specifier) => specifier, "() => Promise.resolve()");
    const module: unknown = await import(`data:text/javascript,${encodeURIComponent(transformed)}`);
    expect(module).toMatchObject({ f: 1 });
  });

  it("rejects dynamic imports with import attributes", async () => {
    const operation = rewriteModule({
      source: 'const data = import("./data.json", { with: { type: "json" } });',
      url: "https://example.test/data.js"
    }, [], async (specifier) => specifier, "load");
    await expect(operation).rejects.toThrow("Import attributes are not supported (1:14)");
  });

  it.each([
    'import data from "./data.json" with { type: "json" };',
    'import data from "./data.json" with {};',
    'export { default } from "./data.json" with { type: "json" };',
  ])("rejects static import attributes: %s", async (source) => {
    const operation = rewriteModule({ source, url: "https://example.test/data.js" }, [], async (specifier) => specifier, "load");
    await expect(operation).rejects.toThrow("Import attributes are not supported (1:1)");
  });

  it("rejects source-phase imports with source context", async () => {
    const sourceURL = "https://example.test/assets/tree.glts";
    const operation = rewriteModule({
      source: 'const child = await import.source("./branch.wasm")',
      url: sourceURL
    }, [sourceURL], async (specifier) => specifier, "load");

    await expect(operation).rejects.toBeInstanceOf(GLTSError);
    await expect(operation).rejects.toThrow("Source- and defer-phase imports are not supported (1:21)");
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
    url: sourceURL
  }, [sourceURL], async (specifier) => specifier, "load");
  const module: unknown = await import(`data:text/javascript,${encodeURIComponent(transformed)}`);
  expect(module).toMatchObject({
    initial: Array(4).fill(sourceURL),
    same: true,
    prototype: null,
    suffix: undefined,
    updated: "changed",
  });
});

it("initializes import.meta.env without replacing import.meta or rewriting property access", async () => {
  const url = "https://example.test/environment.glts";
  const env = { MODE: "staging", DEV: false, PROD: true, SSR: false, VITE_LABEL: 'a "quoted" value', ["__proto__"]: "value" };
  const transformed = await rewriteModule({ url, source: `
    const JSON = {};
    const meta = import.meta;
    const { env, url } = import.meta;
    const property = "env";
    export const values = [env, meta[property], import.meta /* comment */ . env];
    export const same = meta === import.meta;
    export const prototype = Object.getPrototypeOf(meta);
    export const source = new URL("./asset.bin", url).href;
    export const missing = env.UNKNOWN;
  ` }, [], async (specifier) => specifier, "load", env);
  const module: unknown = await import(`data:text/javascript,${encodeURIComponent(transformed)}`);
  expect(module).toMatchObject({
    values: [env, env, env], same: true, prototype: null,
    source: "https://example.test/asset.bin", missing: undefined,
  });
});

it("leaves import.meta.env absent when the host supplies no environment", async () => {
  const transformed = await rewriteModule({
    source: "export const present = Object.hasOwn(import.meta, 'env');",
    url: "https://example.test/no-environment.glts",
  }, [], async (specifier) => specifier, "load");
  const module: unknown = await import(`data:text/javascript,${encodeURIComponent(transformed)}`);
  expect(module).toMatchObject({ present: false });
});

it.each(["\n", "\r", "\r\n", "\u2028", "\u2029"])("keeps a hashbang first with line separator %j", async (separator) => {
  const sourceURL = "https://example.test/hashbang.glts";
  const transformed = await rewriteModule({
    source: `#!/usr/bin/env node${separator}export const url = import.meta.url;`,
    url: sourceURL
  }, [sourceURL], async (specifier) => specifier, "load");
  expect(transformed.startsWith(`#!/usr/bin/env node${separator}import.meta.url = `)).toBe(true);
  const module: unknown = await import(`data:text/javascript,${encodeURIComponent(transformed)}`);
  expect(module).toMatchObject({ url: sourceURL });
});

it("leaves code without import.meta intact and removes sourceURL line separators", async () => {
  const source = "export const value = 1;";
  const transformed = await rewriteModule({
    source,
    url: "https://example.test/\n\r\u2028\u2029plain.js"
  }, [], async (specifier) => specifier, "load");
  expect(transformed).toBe(`${source}\n//# sourceURL=https://example.test/plain.js\n`);
});
