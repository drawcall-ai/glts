import { expect, it } from "vitest";

import { memoryModuleURL, revokeMemoryModuleURL } from "../../src/linker/memory.js";

it("evaluates the same source once per module URL", async () => {
  const counter = { evaluations: 0 };
  Reflect.set(globalThis, "__glts_memory_test", counter);
  const source = "globalThis.__glts_memory_test.evaluations += 1;";
  const urls = [memoryModuleURL(source), memoryModuleURL(source)];
  try {
    for (const url of urls) await import(/* @vite-ignore */ url);
  } finally {
    Reflect.deleteProperty(globalThis, "__glts_memory_test");
    for (const url of urls) revokeMemoryModuleURL(url);
  }
  expect(counter.evaluations).toBe(2);
});

it("evaluates a module that starts with a hashbang", async () => {
  const url = memoryModuleURL("#!/usr/bin/env node\nexport const value = 1;");
  try {
    expect(await import(/* @vite-ignore */ url)).toMatchObject({ value: 1 });
  } finally {
    revokeMemoryModuleURL(url);
  }
});

it("serves no module once revoked", async () => {
  const url = memoryModuleURL("export const value = 1;");
  revokeMemoryModuleURL(url);
  await expect(import(/* @vite-ignore */ url)).rejects.toThrow("revoked");
});
