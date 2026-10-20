export type ViewAngle = "+x" | "-x" | "+y" | "-y" | "+z" | "-z" | "persp";
export interface FocusSphere {
  center: [number, number, number];
  radius: number;
}
export interface View {
  camera: ViewAngle;
  title?: string;
  focus?: string | FocusSphere;
  isolate?: string;
}

const angles: readonly ViewAngle[] = ["+x", "-x", "+y", "-y", "+z", "-z", "persp"];

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finite(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("Focus coordinates and radius must be finite numbers.");
  return value;
}

function nonempty(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) throw new Error("Object names and titles must be nonempty strings.");
  return value;
}

function focus(value: unknown): string | FocusSphere {
  if (typeof value === "string") return nonempty(value);
  if (!isObject(value) || Object.keys(value).some(key => key !== "center" && key !== "radius")) {
    throw new Error("Focus must be an object name or { center: [x, y, z], radius }.");
  }
  if (!Array.isArray(value.center) || value.center.length !== 3) throw new Error("Focus center must contain three numbers.");
  const radius = finite(value.radius);
  if (radius <= 0) throw new Error("Focus radius must be positive.");
  return { center: [finite(value.center[0]), finite(value.center[1]), finite(value.center[2])], radius };
}

function view(value: unknown): View {
  if (!isObject(value)) throw new Error("Each view must be an object.");
  for (const key of Object.keys(value)) {
    if (!["camera", "title", "focus", "isolate"].includes(key)) throw new Error(`Unknown view option: ${key}`);
  }
  const camera = angles.find(angle => angle === value.camera);
  if (!camera) throw new Error(`View camera must be one of ${angles.join(", ")}.`);
  const result: View = { camera };
  if (value.title !== undefined) result.title = nonempty(value.title);
  if (value.focus !== undefined) result.focus = focus(value.focus);
  if (value.isolate !== undefined) result.isolate = nonempty(value.isolate);
  return result;
}

/** Inline JSON only: rows of view objects, with no alternate syntax. */
export function parseViews(source: string): View[][] {
  const rows: unknown = JSON.parse(source);
  if (!Array.isArray(rows) || rows.length === 0) throw new Error("Views must be a nonempty array of rows.");
  return rows.map((row: unknown) => {
    if (!Array.isArray(row) || row.length === 0) throw new Error("Each view row must be a nonempty array.");
    return row.map(view);
  });
}
