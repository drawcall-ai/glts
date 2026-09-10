import type { PhysicsUSDExportOptions } from "@drawcall/physics-usd";
import type { USDZExporter } from "three/addons/exporters/USDZExporter.js";

import type { GLTSScene } from "./types.js";

export type GLTSUSDExportOptions = PhysicsUSDExportOptions;

/** Exports visuals and declared physics without starting a simulation. */
export class GLTSUSDExporter {
  #textureUtils: Parameters<USDZExporter["setTextureUtils"]>[0] = null;

  setTextureUtils(utils: Parameters<USDZExporter["setTextureUtils"]>[0]): void {
    this.#textureUtils = utils;
  }

  async parseAsync(
    scene: GLTSScene,
    options?: GLTSUSDExportOptions,
  ): Promise<Uint8Array<ArrayBuffer>> {
    scene.updateMatrixWorld(true);
    const exporter = await createExporter(scene.capabilities.physics);
    exporter.setTextureUtils(this.#textureUtils);
    return exporter.parseAsync(scene, options);
  }
}

async function createExporter(physics: boolean) {
  if (physics) {
    const { PhysicsUSDExporter } = await import("@drawcall/physics-usd");
    return new PhysicsUSDExporter();
  }
  const { USDZExporter } = await import("three/addons/exporters/USDZExporter.js");
  return new USDZExporter();
}
