import { defineConfig } from "vite";

export default defineConfig({
  resolve: { dedupe: ["three", "@drawcall/physics"] },
  build: { target: "es2022" },
});
