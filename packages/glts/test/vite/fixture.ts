import { mkdir, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export async function writeFiles(root: string, files: Readonly<Record<string, string>>): Promise<void> {
  for (const [path, source] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), source);
  }
}

/** Installs this package's three and its types in `root`, for scripts importing three. */
export async function symlinkThree(root: string): Promise<void> {
  await mkdir(join(root, "node_modules/@types"), { recursive: true });
  for (const name of ["three", "@types/three"]) {
    await symlink(fileURLToPath(new URL(`../../node_modules/${name}`, import.meta.url)), join(root, "node_modules", name));
  }
}

/** A property path of an untyped value, such as an imported module. */
export function get(value: unknown, ...keys: readonly string[]): unknown {
  return keys.reduce<unknown>((object, key) =>
    typeof object === "object" && object !== null ? Reflect.get(object, key) : undefined, value);
}
