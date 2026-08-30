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

function read(namespace: unknown): ReturnType<typeof readAssetExports> {
  return readAssetExports(namespace, context);
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

    expect(read(moduleWith({ previewCamera, previewLighting }))).toEqual({
      assetClass: Asset,
      previewCamera,
      previewLighting
    });
  });

  it("supports modules without preview exports", () => {
    expect(read(moduleWith())).toEqual({
      assetClass: Asset,
      previewCamera: undefined,
      previewLighting: undefined
    });
  });

  it("rejects an invalid default export before reading preview metadata", () => {
    expect(() => read({ default: 42, previewCamera: new THREE.Group() }))
      .toThrow("Module must default-export a constructible class");
  });

  it("accepts a class that returns an Object3D without extending it", () => {
    class AssetFactory {
      constructor() {
        return new THREE.Group();
      }
    }

    const assetClass = read({ default: AssetFactory }).assetClass;
    expect(new assetClass()).toBeInstanceOf(THREE.Group);
  });

  it("does not treat an exported undefined value as an omitted export", () => {
    expect(() => read(moduleWith({ previewCamera: undefined }))).toThrow(
      'Named export "previewCamera" must be a THREE.Camera; received undefined'
    );
  });

  it("rejects a non-camera previewCamera with its received Three.js type", () => {
    const invalid = (): void => {
      read(moduleWith({ previewCamera: new THREE.Group() }));
    };

    expect(invalid).toThrow(GLTSError);
    expect(invalid).toThrow(
      'Named export "previewCamera" must be a THREE.Camera; received THREE.Group'
    );
  });

  it("rejects previewLighting without a light", () => {
    const invalid = (): void => {
      read(moduleWith({ previewLighting: new THREE.Group() }));
    };

    expect(invalid).toThrow(GLTSError);
    expect(invalid).toThrow(
      'Named export "previewLighting" must contain at least one THREE.Light; received THREE.Group with no lights'
    );
  });

  it("rejects previewLighting that is not a Three.js object", () => {
    expect(() => read(moduleWith({ previewLighting: 42 }))).toThrow(
      'Named export "previewLighting" must be a THREE.Object3D containing at least one THREE.Light; received number'
    );
  });
});
