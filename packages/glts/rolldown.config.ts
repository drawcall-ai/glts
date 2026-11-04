// unplugin-typegpu's Babel plugin imports Babel 7's types, which read Node's `process` and so fail in browsers.
// Bundled over tsc's re-export with glts's own Babel 8 types, which do not, it compiles alike in every environment.
import { defineConfig } from "rolldown";

export default defineConfig({
  input: "src/linker/typegpu.ts",
  external: ["@babel/types"],
  platform: "neutral",
  output: { file: "dist/linker/typegpu.js", sourcemap: true },
});
