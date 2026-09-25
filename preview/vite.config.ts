import { defineConfig } from "vite";

export default defineConfig({
  // GitHub Pages serves the site from a repository subpath.
  base: "./",
  resolve: {
    dedupe: ["three", "@drawcall/physics"],
  },
});
