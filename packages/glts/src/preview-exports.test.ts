import * as THREE from "three";
import { describe, expect, it } from "vitest";

import { GLTSError } from "./errors.js";
import { readPreviewExports } from "./preview-exports.js";
import type { GLTSAsset } from "./types.js";

const context = {
  importChain: ["https://example.test/tree.glts"],
  url: "https://example.test/tree.glts"
};

describe("readPreviewExports", () => {
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

    expect(readPreviewExports({ previewCamera, previewLighting }, context)).toEqual({
      previewCamera,
      previewLighting
    });
  });

  it("supports modules without preview exports", () => {
    expect(readPreviewExports({}, context)).toEqual({
      previewCamera: undefined,
      previewLighting: undefined
    });
  });

  it("does not treat an exported undefined value as an omitted export", () => {
    const read = (): void => {
      readPreviewExports({ previewCamera: undefined }, context);
    };

    expect(read).toThrow(
      'Named export "previewCamera" must be a THREE.Camera; received undefined'
    );
  });

  it("rejects a non-camera previewCamera with its received Three.js type", () => {
    const read = (): void => {
      readPreviewExports({ previewCamera: new THREE.Group() }, context);
    };

    expect(read).toThrow(GLTSError);
    expect(read).toThrow(
      'Named export "previewCamera" must be a THREE.Camera; received THREE.Group'
    );
  });

  it("rejects previewLighting without a light", () => {
    const read = (): void => {
      readPreviewExports({ previewLighting: new THREE.Group() }, context);
    };

    expect(read).toThrow(GLTSError);
    expect(read).toThrow(
      'Named export "previewLighting" must contain at least one THREE.Light; received THREE.Group with no lights'
    );
  });

  it("rejects previewLighting that is not a Three.js object", () => {
    const read = (): void => {
      readPreviewExports({ previewLighting: 42 }, context);
    };

    expect(read).toThrow(
      'Named export "previewLighting" must be a THREE.Object3D containing at least one THREE.Light; received number'
    );
  });
});
