import * as THREE from "three";
import { describe, expect, it } from "vitest";

import { readAssetExports } from "./asset-exports.js";
import { GLTSError } from "./errors.js";
import type { GLTSAsset } from "./types.js";

const context = {
  importChain: ["https://example.test/tree.glts"],
  url: "https://example.test/tree.glts"
};

class Asset extends THREE.Group {}

function moduleWith(namedExports: Readonly<Record<string, unknown>> = {}): object {
  return { default: Asset, ...namedExports };
}

describe("readAssetExports", () => {
  it("keeps preview properties optional for existing asset consumers", () => {
    const asset: GLTSAsset = {
      dispose: () => undefined,
      reload: async () => undefined,
      scene: new THREE.Group(),
      url: context.url
    };

    expect(asset.previewCamera).toBeUndefined();
    expect(asset.previewLighting).toBeUndefined();
  });

  it("returns valid camera and lighting exports", () => {
    const previewCamera = new THREE.PerspectiveCamera();
    const previewLighting = new THREE.Group();
    previewLighting.add(new THREE.AmbientLight());

    expect(readAssetExports(moduleWith({ previewCamera, previewLighting }), context)).toEqual({
      assetClass: Asset,
      previewCamera,
      previewLighting
    });
  });

  it("supports modules without preview exports", () => {
    expect(readAssetExports(moduleWith(), context)).toEqual({
      assetClass: Asset,
      previewCamera: undefined,
      previewLighting: undefined
    });
  });

  it("rejects an invalid default export before reading preview metadata", () => {
    const read = (): void => {
      readAssetExports({ default: 42, previewCamera: new THREE.Group() }, context);
    };

    expect(read).toThrow("Module must default-export a constructible Three.js class");
  });

  it("rejects a callable default export that is not constructible", () => {
    const read = (): void => {
      readAssetExports({ default: () => new THREE.Group() }, context);
    };

    expect(read).toThrow("Module must default-export a constructible Three.js class");
  });

  it("does not treat an exported undefined value as an omitted export", () => {
    const read = (): void => {
      readAssetExports(moduleWith({ previewCamera: undefined }), context);
    };

    expect(read).toThrow(
      'Named export "previewCamera" must be a THREE.Camera; received undefined'
    );
  });

  it("rejects a non-camera previewCamera with its received Three.js type", () => {
    const read = (): void => {
      readAssetExports(moduleWith({ previewCamera: new THREE.Group() }), context);
    };

    expect(read).toThrow(GLTSError);
    expect(read).toThrow(
      'Named export "previewCamera" must be a THREE.Camera; received THREE.Group'
    );
  });

  it("rejects previewLighting without a light", () => {
    const read = (): void => {
      readAssetExports(moduleWith({ previewLighting: new THREE.Group() }), context);
    };

    expect(read).toThrow(GLTSError);
    expect(read).toThrow(
      'Named export "previewLighting" must contain at least one THREE.Light; received THREE.Group with no lights'
    );
  });

  it("rejects previewLighting that is not a Three.js object", () => {
    const read = (): void => {
      readAssetExports(moduleWith({ previewLighting: 42 }), context);
    };

    expect(read).toThrow(
      'Named export "previewLighting" must be a THREE.Object3D containing at least one THREE.Light; received number'
    );
  });
});
