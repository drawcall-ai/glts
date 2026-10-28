import { once } from "node:events";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { inspect } from "node:util";
import { withHeadless } from "../headless/index.js";
import { packageName } from "../linker/resolution.js";
import { warmup } from "../loader/warmup.js";
import type { WarmupBuild } from "./warmup.js";

function options(value: unknown): WarmupBuild {
  if (typeof value !== "object" || value === null) throw new Error("Missing GLTS warmup options");
  const string = (key: string): string => {
    const field: unknown = Reflect.get(value, key);
    if (typeof field !== "string") throw new Error(`Invalid GLTS warmup ${key}`);
    return field;
  };
  const strings = (key: string): string[] => {
    const field: unknown = Reflect.get(value, key);
    if (!Array.isArray(field) || !field.every((item: unknown) => typeof item === "string")) {
      throw new Error(`Invalid GLTS warmup ${key}`);
    }
    return field;
  };
  const environment: unknown = Reflect.get(value, "env");
  if (typeof environment !== "object" || environment === null || Array.isArray(environment)) {
    throw new Error("Invalid GLTS warmup env");
  }
  const env = Object.fromEntries(Object.entries(environment).map(([key, field]): [string, string | boolean] => {
    if (typeof field !== "string" && typeof field !== "boolean") throw new Error(`Invalid GLTS warmup env.${key}`);
    return [key, field];
  }));
  return {
    root: string("root"), publicDir: string("publicDir"), cdnURL: string("cdnURL"), base: string("base"),
    scripts: strings("scripts"), packages: strings("packages"), external: strings("external"), env,
  };
}

async function run(config: WarmupBuild): Promise<void> {
  const publicURL = pathToFileURL(`${config.publicDir}/`);
  const appURL = pathToFileURL(`${config.root}/`);
  const base = new URL(config.base, "http://glts.local/").pathname;
  const servedFile = (input: string): string => {
    let path = input;
    if (!path.startsWith("/")) return input;
    if (base !== "/" && path.startsWith(base)) path = path.slice(base.length);
    return new URL(path.replace(/^\/+/, ""), publicURL).href;
  };
  await withHeadless({
    projectURL: appURL, baseURL: publicURL, size: 1, resolveURL: servedFile,
    loader: {
      cdnURL: config.cdnURL, external: config.external, env: config.env,
      resolve: (specifier) => config.packages.includes(packageName(specifier)) ? specifier : undefined,
    },
  }, (loader) => warmup(loader, config.scripts.map((script) => pathToFileURL(resolve(script)))));
}

try {
  const [message]: unknown[] = await once(process, "message");
  await run(options(message));
}
catch (error) {
  const message = inspect(error, { depth: 8, colors: false });
  if (process.send) process.send(message);
  else console.error(message);
  process.exitCode = 1;
}
