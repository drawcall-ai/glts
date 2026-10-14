export type Camera = "+x" | "-x" | "+y" | "-y" | "+z" | "-z" | "persp";
export interface Sphere {
  center: [number, number, number];
  radius: number;
}
export interface View {
  camera: Camera;
  title?: string;
  focus?: string | Sphere;
  isolate?: string;
}

const cameras: readonly Camera[] = ["+x", "-x", "+y", "-y", "+z", "-z", "persp"];

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function number(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("Focus coordinates and radius must be finite numbers.");
  return value;
}

function name(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) throw new Error("Object names and titles must be nonempty strings.");
  return value;
}

function focus(value: unknown): string | Sphere {
  if (typeof value === "string") return name(value);
  if (!record(value) || Object.keys(value).some(key => key !== "center" && key !== "radius")) {
    throw new Error("Focus must be an object name or { center: [x, y, z], radius }.");
  }
  if (!Array.isArray(value.center) || value.center.length !== 3) throw new Error("Focus center must contain three numbers.");
  const radius = number(value.radius);
  if (radius <= 0) throw new Error("Focus radius must be positive.");
  return { center: [number(value.center[0]), number(value.center[1]), number(value.center[2])], radius };
}

function view(value: unknown): View {
  if (!record(value)) throw new Error("Each view must be an object.");
  for (const key of Object.keys(value)) {
    if (!["camera", "title", "focus", "isolate"].includes(key)) throw new Error(`Unknown view option: ${key}`);
  }
  const camera = cameras.find(camera => camera === value.camera);
  if (!camera) throw new Error(`View camera must be one of ${cameras.join(", ")}.`);
  const result: View = { camera };
  if (value.title !== undefined) result.title = name(value.title);
  if (value.focus !== undefined) result.focus = focus(value.focus);
  if (value.isolate !== undefined) result.isolate = name(value.isolate);
  return result;
}

/** Inline JSON only: rows of rig-style view objects, with no alternate syntax. */
export function parseViews(source: string): View[][] {
  const rows: unknown = JSON.parse(source);
  if (!Array.isArray(rows) || rows.length === 0) throw new Error("Views must be a nonempty array of rows.");
  return rows.map((row: unknown) => {
    if (!Array.isArray(row) || row.length === 0) throw new Error("Each view row must be a nonempty array.");
    return row.map(view);
  });
}
