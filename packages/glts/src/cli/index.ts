#!/usr/bin/env node
import { Command, InvalidArgumentError } from "commander";
import { parseViews, type View } from "./views.js";

function size(value: string): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > 8192) throw new InvalidArgumentError("Size must be an integer from 1 to 8192 pixels per view.");
  return number;
}

function time(value: string): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new InvalidArgumentError("Time must be a nonnegative number of seconds.");
  return number;
}

function views(value: string): View[][] {
  try { return parseViews(value); }
  catch (error) { throw new InvalidArgumentError(error instanceof Error ? error.message : String(error)); }
}

interface RenderOptions { output: string; size: number; time: number; views?: View[][] }
interface ExportOptions { output: string }

const program = new Command().name(process.env.DRAWCALL_INVOCATION || "glts").description("Render GLTS assets to PNG or export them to GLB.");

program.command("render")
  .description("Render an asset or a contact sheet using inline JSON views.")
  .argument("<file.glts>", "GLTS source file")
  .requiredOption("-o, --output <file.png>", "output PNG path")
  .option("--size <pixels>", "pixels per square view", size, 768)
  .option("--time <seconds>", "simulate from zero in 1/60-second steps", time, 0)
  .option("--views <json>", 'rows of view objects, e.g. [[{"camera":"+x"},{"camera":"persp"}]]', views)
  .action(async (source: string, options: RenderOptions) => {
    const { withScene } = await import("./runtime.js");
    const { renderScene } = await import("./render.js");
    const { writeOutput } = await import("./output.js");
    const bytes = await withScene(source, true, scene => renderScene(scene, options));
    await writeOutput(options.output, bytes);
  });

program.command("export")
  .description("Export the constructed asset and explicit animation clips to GLB; preview staging and frame callbacks are excluded.")
  .argument("<file.glts>", "GLTS source file")
  .requiredOption("-o, --output <file.glb>", "output GLB path")
  .action(async (source: string, options: ExportOptions) => {
    const { withScene } = await import("./runtime.js");
    const { exportScene } = await import("./export.js");
    const { writeOutput } = await import("./output.js");
    const bytes = await withScene(source, false, exportScene);
    await writeOutput(options.output, bytes);
  });

try { await program.parseAsync(); }
catch (error) {
  console.error(error);
  process.exitCode = 1;
}
