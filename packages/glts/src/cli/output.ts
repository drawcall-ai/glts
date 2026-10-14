import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";

export async function writeOutput(path: string, bytes: Uint8Array): Promise<void> {
  const output = resolve(path);
  await mkdir(dirname(output), { recursive: true });
  const temporary = `${output}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, bytes, { flag: "wx" });
    await rename(temporary, output);
  } finally {
    await rm(temporary, { force: true });
  }
  console.log(output);
}
