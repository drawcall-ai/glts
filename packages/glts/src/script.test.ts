import { describe, expect, it } from "vitest";

import { GLTSError } from "./errors.js";
import { validateScript } from "./script.js";

const context = {
  importChain: ["https://example.test/tree.glts"],
  url: "https://example.test/tree.glts"
};

describe("validateScript", () => {
  it("accepts exportless scripts with contextual imports", () => {
    expect(() => validateScript(`
      import * as THREE from "three"
      import { scene, isPreview, onDispose } from "@drawcall/glts"
      if (isPreview) scene.add(new THREE.Group())
      onDispose(() => undefined)
    `, context)).not.toThrow();
  });

  it("rejects exports", () => {
    expect(() => validateScript("export const value = 1", context))
      .toThrow("GLTS scripts must not export values");
  });

  it("rejects GLTSLoader in favor of the contextual instance", () => {
    const validate = (): void => validateScript(
      'import { GLTSLoader } from "@drawcall/glts"',
      context
    );
    expect(validate).toThrow(GLTSError);
    expect(validate).toThrow("import gltsLoader instead");
  });

  it("rejects static GLTS imports", () => {
    expect(() => validateScript('import Child from "./child.glts"', context))
      .toThrow("use gltsLoader.loadAsync()");
  });
});
