import { expect, it, vi } from "vitest";

it("keeps names unique across copies of GLTS in one realm", async () => {
  const first = await import("../src/urls.js");
  vi.resetModules();
  const second = await import("../src/urls.js");
  expect(first.realmUnique("key-")).not.toBe(second.realmUnique("key-"));
});
