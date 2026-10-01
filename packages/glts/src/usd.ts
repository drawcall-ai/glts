import type { PhysicsUSDExporter, PhysicsUSDExportOptions } from "@drawcall/physics-usd";
import type { USDZExporter } from "three/addons/exporters/USDZExporter.js";

import type { GLTSScene } from "./types.js";

export type GLTSUSDExportOptions = PhysicsUSDExportOptions;

export interface GLTSUSDExporterOptions {
  /** Exports declared physics; required for physical assets. */
  physics?: typeof PhysicsUSDExporter;
}

/** Exports visuals and declared physics without starting a simulation. */
export class GLTSUSDExporter {
  readonly #physics: typeof PhysicsUSDExporter | undefined;
  #textureUtils: Parameters<USDZExporter["setTextureUtils"]>[0] = null;

  constructor(options: GLTSUSDExporterOptions = {}) {
    this.#physics = options.physics;
  }

  setTextureUtils(utils: Parameters<USDZExporter["setTextureUtils"]>[0]): void {
    this.#textureUtils = utils;
  }

  async parseAsync(
    scene: GLTSScene,
    options?: GLTSUSDExportOptions,
  ): Promise<Uint8Array<ArrayBuffer>> {
    scene.updateMatrixWorld(true);
    const exporter = await this.#createExporter(scene);
    exporter.setTextureUtils(this.#textureUtils);
    return exporter.parseAsync(scene, options);
  }

  async #createExporter(scene: GLTSScene) {
    if (!scene.capabilities.physics) {
      const { USDZExporter } = await import("three/addons/exporters/USDZExporter.js");
      return new USDZExporter();
    }
    if (!this.#physics) {
      throw new Error(
        `${scene.url} declares physics; pass { physics: PhysicsUSDExporter } from @drawcall/physics-usd`,
      );
    }
    return new this.#physics();
  }
}
