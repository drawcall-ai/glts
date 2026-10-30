import type { GLTSModuleSource } from "../types.js";

export function loaderSource(cdnURL: string, env: Readonly<Record<string, string | boolean>>): string {
  return `
import { GLTSLoader as Loader } from "@drawcall/glts";
import modules, { moduleSources } from "virtual:glts-modules";
export * from "@drawcall/glts";
const env = JSON.parse(${JSON.stringify(JSON.stringify(env))});

export class GLTSLoader extends Loader {
  #reload = ({ url }) => void this.reload(new URL(url, location.href));

  constructor(manager, options = {}) {
    const bundledSources = Object.fromEntries(Object.entries(moduleSources).filter(([name]) => !(name in (options.modules ?? {}))));
    super(manager, { cdnURL: ${JSON.stringify(cdnURL)}, env, ...options,
      modules: { ...modules, ...options.modules }, moduleSources: { ...bundledSources, ...options.moduleSources } });
    import.meta.hot?.on("glts:reload", this.#reload);
  }

  dispose() {
    import.meta.hot?.off("glts:reload", this.#reload);
    super.dispose();
  }
}
`;
}

export function hostModulesSource(specifiers: readonly string[], moduleSources: Readonly<Record<string, GLTSModuleSource>>): string {
  const imports = specifiers.map((specifier, index) =>
    `import * as m${index} from ${JSON.stringify(specifier)};`);
  const entries = specifiers.map((specifier, index) => `${JSON.stringify(specifier)}: m${index}`);
  return [...imports, `export default { ${entries.join(", ")} };`,
    `export const moduleSources = ${JSON.stringify(moduleSources)};`].join("\n");
}

