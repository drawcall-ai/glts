import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export async function writeFiles(root: string, files: Readonly<Record<string, string>>): Promise<void> {
  for (const [path, source] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), source);
  }
}

/** A property path of an untyped value, such as an imported module. */
export function get(value: unknown, ...keys: readonly string[]): unknown {
  return keys.reduce<unknown>((object, key) =>
    typeof object === "object" && object !== null ? Reflect.get(object, key) : undefined, value);
}
