import { describe, expect, it } from "vitest";

import {
  analyzeDependencyModule,
  type PreviewExportSyntax
} from "./inline-analysis.js";

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

function removedSource(source: string, previewExport: PreviewExportSyntax): string {
  const range = previewExport.kind === "declaration"
    ? previewExport.exportPrefix
    : previewExport.exportStatement;
  return source.slice(range.start, range.end);
}

describe("analyzeDependencyModule", () => {
  it("models declaration and list preview exports as distinct source removals", () => {
    const source = `export const previewCamera = camera;
const previewLighting = lighting;
export { previewLighting };
export default class Branch {}`;

    const module = analyze(source);

    expect(module.defaultClass).toMatchObject({ kind: "named", name: "Branch" });
    expect(module.previewExports.map((value) => value.kind)).toEqual([
      "declaration",
      "list"
    ]);
    expect(module.previewExports.map((value) => removedSource(source, value))).toEqual([
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
