import { expect, test } from "@playwright/test";

import { routeGLTS, routeGLTSRevisions } from "./routes.js";

test("applies authored rendering without taking ownership of the host renderer or camera", async ({
  page
}) => {
  await routeGLTS(page, "**/assets/rendering.glts", `
    import * as THREE from "three"
    import { scene } from "@drawcall/glts"
    import { Pass } from "three/addons/postprocessing/Pass.js"

    class ProbePass extends Pass {
      needsSwap = false
      render(renderer) {
        globalThis.__effectRenders = (globalThis.__effectRenders ?? 0) + 1
        globalThis.__effectProfile = {
          clipping: renderer.localClippingEnabled,
          exposure: renderer.toneMappingExposure,
          shadows: renderer.shadowMap.enabled,
          toneMapping: renderer.toneMapping,
        }
      }
      dispose() {
        globalThis.__effectDisposals = (globalThis.__effectDisposals ?? 0) + 1
      }
    }

    const defaultCamera = new THREE.PerspectiveCamera(35, 1, 0.1, 10)
    defaultCamera.name = "authored camera"
    scene.defaultCamera = defaultCamera
    scene.background = new THREE.Color("#123456")
    scene.fog = new THREE.Fog("#123456", 1, 10)
    scene.rendering.localClippingEnabled = true
    scene.rendering.shadows = true
    scene.rendering.toneMapping = THREE.LinearToneMapping
    scene.rendering.toneMappingExposure = 2
    scene.rendering.effects.push(({ camera, height, scene: root, width }) => {
      globalThis.__effectCreations = (globalThis.__effectCreations ?? 0) + 1
      globalThis.__effectContext = {
        camera,
        height,
        root: root === scene,
        width,
      }
      return new ProbePass()
    })
  `);

  await page.goto("/test-harness.html");
  const result = await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    const renderer = new window.WebGLRenderer({
      canvas,
      outputBufferType: window.HalfFloatType
    });
    renderer.setSize(32, 24, false);
    renderer.localClippingEnabled = false;
    renderer.shadowMap.enabled = false;
    renderer.toneMappingExposure = 0.75;

    const loader = new window.GLTSLoader(new window.LoadingManager());
    const scene = await loader.loadAsync("/assets/rendering.glts");
    const camera = scene.defaultCamera;
    if (!(camera instanceof window.PerspectiveCamera)) {
      throw new Error("Expected authored perspective camera");
    }
    const replacementCamera = new window.PerspectiveCamera(45, 1, 0.1, 10);
    const gltsRenderer = new window.GLTSRenderer(renderer);
    let duplicateError = "";
    try {
      new window.GLTSRenderer(renderer);
    } catch (error) {
      duplicateError = error instanceof Error ? error.message : String(error);
    }

    gltsRenderer.render(scene);
    gltsRenderer.render(scene);
    const context = Reflect.get(globalThis, "__effectContext");
    const afterTwoRenders = {
      camera: context.camera === camera,
      creations: Reflect.get(globalThis, "__effectCreations"),
      disposals: Reflect.get(globalThis, "__effectDisposals") ?? 0,
      height: context.height,
      profile: Reflect.get(globalThis, "__effectProfile"),
      renders: Reflect.get(globalThis, "__effectRenders"),
      root: context.root,
      width: context.width
    };

    gltsRenderer.render(scene, replacementCamera);
    const afterCameraChange = {
      camera: Reflect.get(globalThis, "__effectContext").camera === replacementCamera,
      creations: Reflect.get(globalThis, "__effectCreations"),
      disposals: Reflect.get(globalThis, "__effectDisposals"),
      renders: Reflect.get(globalThis, "__effectRenders")
    };
    scene.defaultCamera = undefined;
    const hierarchyCamera = new window.PerspectiveCamera();
    scene.add(hierarchyCamera);
    let hierarchyCameraError = "";
    try {
      gltsRenderer.render(scene);
    } catch (error) {
      hierarchyCameraError = error instanceof Error ? error.message : String(error);
    }
    scene.remove(hierarchyCamera);
    scene.defaultCamera = camera;
    const rendererState = {
      clipping: renderer.localClippingEnabled,
      exposure: renderer.toneMappingExposure,
      shadows: renderer.shadowMap.enabled,
      toneMapping: renderer.toneMapping
    };
    const target = new window.WebGLRenderTarget(4, 4);
    renderer.setRenderTarget(target);
    let targetError = "";
    try {
      gltsRenderer.render(scene, camera);
    } catch (error) {
      targetError = error instanceof Error ? error.message : String(error);
    }
    renderer.setRenderTarget(null);
    target.dispose();

    renderer.setViewport(0, 0, 16, 24);
    let viewportError = "";
    try {
      gltsRenderer.render(scene, camera);
    } catch (error) {
      viewportError = error instanceof Error ? error.message : String(error);
    }
    renderer.setViewport(0, 0, 32, 24);

    gltsRenderer.release(scene);
    const finalDisposals = Reflect.get(globalThis, "__effectDisposals");
    gltsRenderer.dispose();
    const replacementRenderer = new window.GLTSRenderer(renderer);
    replacementRenderer.dispose();

    const defaultRenderer = new window.WebGLRenderer({
      canvas: document.createElement("canvas")
    });
    defaultRenderer.setSize(8, 8, false);
    const unsupportedRenderer = new window.GLTSRenderer(defaultRenderer);
    const sceneEffects = scene.rendering.effects;
    scene.rendering.effects = [];
    const splitCamera = camera.clone();
    splitCamera.viewport = new window.Vector4(0, 0, 4, 8);
    defaultRenderer.render(new window.Scene(), new window.ArrayCamera([splitCamera]));
    let staleViewportError = "";
    try {
      unsupportedRenderer.render(scene, camera);
    } catch (error) {
      staleViewportError = error instanceof Error ? error.message : String(error);
    }
    defaultRenderer.setViewport(0, 0, 8, 8);

    defaultRenderer.setPixelRatio(1.25);
    defaultRenderer.setSize(7, 5, false);
    let fractionalViewportError = "";
    try {
      unsupportedRenderer.render(scene, camera);
      unsupportedRenderer.render(scene, camera);
    } catch (error) {
      fractionalViewportError = error instanceof Error ? error.message : String(error);
    }

    defaultRenderer.setViewport(0, 0, 4, 5);
    splitCamera.viewport.set(0, 0, 9, 6);
    defaultRenderer.render(new window.Scene(), new window.ArrayCamera([splitCamera]));
    let configuredViewportError = "";
    try {
      unsupportedRenderer.render(scene, camera);
    } catch (error) {
      configuredViewportError = error instanceof Error ? error.message : String(error);
    }
    defaultRenderer.setViewport(0, 0, 7, 5);
    scene.rendering.effects = sceneEffects;
    let unsupportedError = "";
    try {
      unsupportedRenderer.render(scene, camera);
    } catch (error) {
      unsupportedError = error instanceof Error ? error.message : String(error);
    }
    const unsupportedDisposals = Reflect.get(globalThis, "__effectDisposals");
    unsupportedRenderer.dispose();
    defaultRenderer.dispose();

    scene.dispose();
    loader.dispose();
    renderer.dispose();
    return {
      afterCameraChange,
      afterTwoRenders,
      configuredViewportError,
      duplicateError,
      finalDisposals,
      fractionalViewportError,
      hierarchyCameraError,
      rendererState,
      staleViewportError,
      targetError,
      unsupportedError,
      unsupportedDisposals,
      viewportError
    };
  });

  expect(result).toEqual({
    afterCameraChange: {
      camera: true,
      creations: 2,
      disposals: 1,
      renders: 3
    },
    afterTwoRenders: {
      camera: true,
      creations: 1,
      disposals: 0,
      height: 24,
      profile: {
        clipping: true,
        exposure: 2,
        shadows: true,
        toneMapping: 1
      },
      renders: 2,
      root: true,
      width: 32
    },
    configuredViewportError:
      "GLTS effects and tone mapping require a full viewport with scissor testing disabled",
    duplicateError: "A WebGLRenderer can have only one active GLTSRenderer",
    finalDisposals: 2,
    fractionalViewportError: "",
    hierarchyCameraError:
      "GLTSRenderer.render() requires a camera or scene.defaultCamera",
    rendererState: {
      clipping: false,
      exposure: 0.75,
      shadows: false,
      toneMapping: 0
    },
    staleViewportError: "",
    targetError: "GLTS effects and tone mapping require the default WebGL framebuffer",
    unsupportedError:
      "GLTS effects require a WebGLRenderer constructed with GLTSRenderer.parameters",
    unsupportedDisposals: 3,
    viewportError:
      "GLTS effects and tone mapping require a full viewport with scissor testing disabled"
  });
});

test("reloads native scene presentation into the stable root", async ({ page }) => {
  await routeGLTSRevisions(page, "**/assets/presentation.glts", [
    `
      import * as THREE from "three"
      import { scene } from "@drawcall/glts"
      scene.background = new THREE.Color("red")
      scene.defaultCamera = new THREE.PerspectiveCamera()
      scene.fog = new THREE.Fog("red", 1, 2)
      scene.environmentIntensity = 0.5
      scene.rendering.shadows = true
      scene.rendering.toneMappingExposure = 2
      scene.rendering.effects.push(() => { throw new Error("unused") })
    `,
    `
      import * as THREE from "three"
      import { scene } from "@drawcall/glts"
      scene.background = new THREE.Color("blue")
      scene.fog = new THREE.Fog("blue", 3, 4)
      scene.environmentIntensity = 1.5
      scene.rendering.toneMappingExposure = 0.8
    `
  ]);

  await page.goto("/test-harness.html");
  const result = await page.evaluate(async () => {
    const loader = new window.GLTSLoader(new window.LoadingManager());
    const scene = await loader.loadAsync("/assets/presentation.glts");
    const stable = scene;
    scene.position.x = 7;
    await scene.reload();
    const result = {
      background: scene.background && "getHexString" in scene.background
        ? scene.background.getHexString()
        : "",
      defaultCamera: scene.defaultCamera,
      effects: scene.rendering.effects.length,
      environmentIntensity: scene.environmentIntensity,
      exposure: scene.rendering.toneMappingExposure,
      fogFar: scene.fog && "far" in scene.fog ? scene.fog.far : 0,
      position: scene.position.x,
      shadows: scene.rendering.shadows,
      stable: scene === stable
    };
    scene.dispose();
    loader.dispose();
    return result;
  });

  expect(result).toEqual({
    background: "0000ff",
    defaultCamera: undefined,
    effects: 0,
    environmentIntensity: 1.5,
    exposure: 0.8,
    fogFar: 4,
    position: 7,
    shadows: false,
    stable: true
  });
});

test("rebuilds effects after reload and recovers after a pass throws", async ({
  page
}) => {
  const source = `
    import { scene } from "@drawcall/glts"
    import { Pass } from "three/addons/postprocessing/Pass.js"

    globalThis.__stableEffectFactory ??= () => {
      globalThis.__stableEffectCreations =
        (globalThis.__stableEffectCreations ?? 0) + 1
      return new class extends Pass {
        needsSwap = false
        render(_renderer, _writeBuffer, _readBuffer, delta) {
          globalThis.__stableEffectAttempts =
            (globalThis.__stableEffectAttempts ?? 0) + 1
          globalThis.__stableEffectDeltas ??= []
          globalThis.__stableEffectDeltas.push(delta)
          if (globalThis.__stableEffectAttempts === 1) {
            throw new Error("probe effect failed")
          }
        }
        dispose() {
          globalThis.__stableEffectDisposals =
            (globalThis.__stableEffectDisposals ?? 0) + 1
        }
      }()
    }
    scene.rendering.effects.push(globalThis.__stableEffectFactory)
  `;
  await routeGLTSRevisions(page, "**/assets/stable-effect.glts", [source, source]);
  await routeGLTS(page, "**/assets/invalid-effect.glts", `
    import { scene } from "@drawcall/glts"
    scene.rendering.effects.push(() => null)
  `);

  await page.goto("/test-harness.html");
  const result = await page.evaluate(async () => {
    const renderer = new window.WebGLRenderer({
      canvas: document.createElement("canvas"),
      outputBufferType: window.HalfFloatType
    });
    renderer.setSize(16, 16, false);
    const loader = new window.GLTSLoader(new window.LoadingManager());
    const scene = await loader.loadAsync("/assets/stable-effect.glts");
    const camera = new window.PerspectiveCamera();
    const gltsRenderer = new window.GLTSRenderer(renderer);

    let firstError = "";
    try {
      gltsRenderer.render(scene, camera, 0.1);
    } catch (error) {
      firstError = error instanceof Error ? error.message : String(error);
    }
    gltsRenderer.render(scene, camera, 0.1);
    await scene.reload();
    gltsRenderer.render(scene, camera, 0.1);

    const snapshot = {
      attempts: Reflect.get(globalThis, "__stableEffectAttempts"),
      creations: Reflect.get(globalThis, "__stableEffectCreations"),
      deltas: Reflect.get(globalThis, "__stableEffectDeltas"),
      disposals: Reflect.get(globalThis, "__stableEffectDisposals"),
      firstError
    };
    gltsRenderer.release(scene);
    const finalDisposals = Reflect.get(globalThis, "__stableEffectDisposals");

    const invalid = await loader.loadAsync("/assets/invalid-effect.glts");
    let invalidError = "";
    try {
      gltsRenderer.render(invalid, camera);
    } catch (error) {
      invalidError = error instanceof Error ? error.message : String(error);
    }
    invalid.dispose();
    gltsRenderer.dispose();
    scene.dispose();
    loader.dispose();
    renderer.dispose();
    return { ...snapshot, finalDisposals, invalidError };
  });

  expect(result).toEqual({
    attempts: 3,
    creations: 2,
    deltas: [0.1, 0.1, 0.1],
    disposals: 1,
    finalDisposals: 2,
    firstError: "probe effect failed",
    invalidError: "GLTS effect factories must return a Three.js Pass"
  });
});
