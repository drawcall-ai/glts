import { fork } from "node:child_process";

export interface WarmupBuild {
  readonly root: string;
  readonly publicDir: string;
  readonly packages: readonly string[];
  readonly external: readonly string[];
  readonly scripts: readonly string[];
  readonly cdnURL: string;
  readonly base: string;
  readonly env: Readonly<Record<string, string | boolean>>;
}

/** Runs before Vite copies public files, with asset caches rooted in the app and headless globals isolated. */
export async function warmupBuild(options: WarmupBuild): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = fork(new URL("./run.js", import.meta.url), {
      cwd: options.root,
      execArgv: [],
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    });
    let failure: string | undefined;
    child.on("message", (message: unknown) => { if (typeof message === "string") failure = message; });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(failure ?? `GLTS build warmup exited with ${signal ?? `code ${code}`}`));
    });
    child.send(options, (error) => { if (error) reject(error); });
  });
}
