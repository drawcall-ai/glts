import { describe, expect, it } from "vitest";

import { renderGLTSImage } from "../src/index.js";

function image(url: string) {
  return { url, altText: "Crystal" };
}

describe("renderGLTSImage", () => {
  it("draws .glts images, with or without a query or hash", () => {
    for (const url of ["/crystal.glts", "https://example.com/Crystal.GLTS?seed=1", "crystal.glts#top"]) {
      expect(renderGLTSImage(image(url))).toBeDefined();
    }
  });

  it("leaves every other image to the default renderer", () => {
    for (const url of ["/photo.png", "/crystal.glts.png", "/glts"]) {
      expect(renderGLTSImage(image(url))).toBeUndefined();
    }
  });
});
