import { expect, it } from "vitest";

import { moduleURL } from "../../src/modules/urls.js";

it("evaluates the same source once per module URL", async () => {
  const counter = { evaluations: 0 };
  Reflect.set(globalThis, "__glts_urls_test", counter);
  const source = "globalThis.__glts_urls_test.evaluations += 1;";
  try {
    await import(/* @vite-ignore */ moduleURL(source));
    await import(/* @vite-ignore */ moduleURL(source));
  } finally {
    Reflect.deleteProperty(globalThis, "__glts_urls_test");
  }
  expect(counter.evaluations).toBe(2);
});

it("evaluates a module that starts with a hashbang", async () => {
  const module: unknown = await import(/* @vite-ignore */ moduleURL("#!/usr/bin/env node\nexport const value = 1;"));
  expect(module).toMatchObject({ value: 1 });
});
