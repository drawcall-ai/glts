import { transform } from "sucrase";

export function compileTypeScript(source: string): string {
  return transform(source, {
    disableESTransforms: true,
    keepUnusedImports: true,
    transforms: ["typescript"]
  }).code;
}
