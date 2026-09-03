import { expect, it, vi } from "vitest";

import { ModuleURLStore } from "./module-url-store.js";

it("cannot create module URLs after disposal", () => {
  const createObjectURL = vi.spyOn(URL, "createObjectURL")
    .mockReturnValue("blob:test");
  const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL")
    .mockImplementation(() => undefined);
  const store = new ModuleURLStore();
  store.create("export {};");
  store.dispose();

  expect(() => store.create("export {};")).toThrow("has been disposed");
  expect(createObjectURL).toHaveBeenCalledOnce();
  expect(revokeObjectURL).toHaveBeenCalledOnce();
  expect(revokeObjectURL).toHaveBeenCalledWith("blob:test");
});
