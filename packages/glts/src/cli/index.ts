#!/usr/bin/env node
import { enableCompileCache } from "node:module";
import { Command, InvalidArgumentError } from "commander";
import type { ExportOptions } from "./export.js";
import type { RenderOptions } from "./render.js";
import { parseViews, type View } from "./views.js";

function size(value: string): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > 8192) throw new InvalidArgumentError("Size must be an integer from 1 to 8192 pixels per view.");
  return number;
}

function time(value: string): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new InvalidArgumentError("Time must be a non-negative number of seconds.");
  return number;
}

function views(value: string): View[][] {
  try { return parseViews(value); }
  catch (error) { throw new InvalidArgumentError(error instanceof Error ? error.message : String(error)); }
}

function packages(value: string): string[] {
  return value.split(",").map(name => name.trim()).filter(name => name !== "");
}

const dedupe = "packages resolved from the app's root wherever they are imported, comma-separated: the app's Vite resolve.dedupe";

// Each command is a fresh process; V8 reuses its compilation of the modules commands import, such as Three and Babel.
enableCompileCache();

const program = new Command().name(process.env.DRAWCALL_INVOCATION || "npx @drawcall/glts").description("Render GLTS assets to PNG or export them to GLB.");

program.command("render")
  .description("Render an asset or a contact sheet using inline JSON views.")
  .argument("<file.glts>", "GLTS script")
  .requiredOption("-o, --output <file.png>", "output PNG path")
  .option("--size <pixels>", "pixels per square view", size, 768)
  .option("--time <seconds>", "simulate from zero in 1/60-second steps, and render at that time", time, 0)
  .option("--views <json>", 'rows of view objects, e.g. [[{"camera":"+x"},{"camera":"persp"}]]', views)
  .option("--dedupe <packages>", dedupe, packages)
  .action(async (file: string, { output, ...options }: RenderOptions & { output: string }) => {
    const [{ render }, { write }] = await Promise.all([import("./render.js"), import("./headless.js")]);
    await write(output, await render(file, options));
  });

program.command("export")
  .description("Export the constructed asset and explicit animation clips to GLB; preview staging and frame callbacks are excluded.")
  .argument("<file.glts>", "GLTS script")
  .requiredOption("-o, --output <file.glb>", "output GLB path")
  .option("--dedupe <packages>", dedupe, packages)
  .action(async (file: string, options: ExportOptions) => {
    const { exportFile } = await import("./export.js");
    await exportFile(file, options);
  });

try { await program.parseAsync(); }
catch (error) {
  console.error(error);
  process.exitCode = 1;
}
// A failed command ends once its output is flushed: a script that threw midway can leave timers it started running,
// such as a setInterval whose onDispose it never reached, and they would keep Node.js alive.
if (process.exitCode) {
  const flushed = (stream: NodeJS.WriteStream) => new Promise<void>((resolve) => stream.write("", () => resolve()));
  await Promise.all([flushed(process.stdout), flushed(process.stderr)]);
  process.exit();
}
