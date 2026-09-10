import * as THREE from "three";
import type { Pass } from "three/addons/postprocessing/Pass.js";

export type GLTSScriptScene = Omit<THREE.Scene, "clone"> & {
  clone(recursive?: boolean): THREE.Scene;
  defaultCamera: THREE.Camera | undefined;
  readonly rendering: GLTSRenderingProfile;
};

export interface GLTSEffectContext {
  readonly camera: THREE.Camera;
  readonly height: number;
  readonly scene: GLTSScriptScene;
  readonly width: number;
}

export type GLTSEffect = (context: GLTSEffectContext) => Pass;

export interface GLTSRenderingProfile {
  effects: GLTSEffect[];
  localClippingEnabled: boolean;
  shadows: boolean;
  toneMapping: THREE.ToneMapping;
  toneMappingExposure: number;
}

export function createScriptScene(): GLTSScriptScene {
  return Object.assign(new THREE.Scene(), {
    defaultCamera: undefined,
    rendering: {
      effects: [],
      localClippingEnabled: false,
      shadows: false,
      toneMapping: THREE.NoToneMapping,
      toneMappingExposure: 1
    }
  });
}

export function copyRootState(target: GLTSScriptScene, source: GLTSScriptScene): void {
  // The revision owns root metadata and render state; the caller owns its transform.
  target.name = source.name;
  target.layers.mask = source.layers.mask;
  target.visible = source.visible;
  target.castShadow = source.castShadow;
  target.receiveShadow = source.receiveShadow;
  target.frustumCulled = source.frustumCulled;
  target.renderOrder = source.renderOrder;
  target.animations = source.animations.slice();
  target.userData = source.userData;
  target.defaultCamera = source.defaultCamera;
  target.background = source.background;
  target.backgroundBlurriness = source.backgroundBlurriness;
  target.backgroundIntensity = source.backgroundIntensity;
  target.backgroundRotation.copy(source.backgroundRotation);
  target.environment = source.environment;
  target.environmentIntensity = source.environmentIntensity;
  target.environmentRotation.copy(source.environmentRotation);
  target.fog = source.fog;
  target.overrideMaterial = source.overrideMaterial;
  Object.assign(target.rendering, source.rendering, {
    effects: source.rendering.effects.slice()
  });
}

