import * as THREE from "three/webgpu";

import type { GLTSScriptScene, RootState } from "./types.js";

/**
 * A script's root as created, which becomes the managed node its load returns. Unlike GLTSScriptScene, its
 * methods return the node itself, so augmenting it yields a GLTSScene.
 */
export type ScriptRoot = THREE.Scene & RootState;

export function createRoot(): ScriptRoot {
  return Object.assign(new THREE.Scene(), {
    defaultCamera: undefined,
    rendering: {
      effects: [],
      shadows: false,
      toneMapping: THREE.NoToneMapping,
      toneMappingExposure: 1
    }
  });
}

export function copyRootState(target: GLTSScriptScene, from: GLTSScriptScene): void {
  // The execution owns root metadata and render state; the caller owns its transform.
  target.name = from.name;
  target.layers.mask = from.layers.mask;
  target.visible = from.visible;
  target.castShadow = from.castShadow;
  target.receiveShadow = from.receiveShadow;
  target.frustumCulled = from.frustumCulled;
  target.renderOrder = from.renderOrder;
  target.animations = from.animations.slice();
  target.userData = from.userData;
  target.defaultCamera = from.defaultCamera;
  target.background = from.background;
  target.backgroundNode = from.backgroundNode;
  target.backgroundBlurriness = from.backgroundBlurriness;
  target.backgroundIntensity = from.backgroundIntensity;
  target.backgroundRotation.copy(from.backgroundRotation);
  target.environment = from.environment;
  target.environmentNode = from.environmentNode;
  target.environmentIntensity = from.environmentIntensity;
  target.environmentRotation.copy(from.environmentRotation);
  target.fog = from.fog;
  target.fogNode = from.fogNode;
  target.overrideMaterial = from.overrideMaterial;
  Object.assign(target.rendering, from.rendering, {
    effects: from.rendering.effects.slice()
  });
}
