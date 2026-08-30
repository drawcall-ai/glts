import { describe, expect, it } from "vitest";

import { analyzeDependencyModule } from "./inline-analysis.js";

const url = new URL("https://example.test/branch.glts");

function analyze(source: string): ReturnType<typeof analyzeDependencyModule> {
  return analyzeDependencyModule({
    metaURL: url.href,
    path: "./branch.glts",
    resolveImport: () => undefined,
    source,
    url
  });
}

describe("analyzeDependencyModule", () => {
  it("returns every source range removed from an inlined dependency", () => {
    const source = `import { BoxGeometry } from "three";
export const previewCamera = camera;
const previewLighting = lighting;
export { previewLighting };
export default class Branch {}`;

    const module = analyze(source);

    expect(module.defaultClass).toMatchObject({ kind: "named", name: "Branch" });
    expect(module.removals.map((range) => source.slice(range.start, range.end))).toEqual([
      "import { BoxGeometry } from \"three\";",
      "export ",
      "export { previewLighting };"
    ]);
  });

  it("returns only fully validated dependency modules", () => {
    expect(() => analyze("export const previewCamera = camera;")).toThrow(
      "Inlined dependency must have a default export"
    );
    expect(() => analyze("export const value = 1; export default class Branch {}"))
      .toThrow("Inlined dependencies may only have a default export");
  });
});
