import { expect, test } from "@playwright/test";

import { routeScript, routeScriptRevisions } from "./routes.js";

test("renders TSL effects and restores the host's rendering settings", async ({ page }) => {
  await routeScript(page, "**/assets/rendering.glts", `
    import * as THREE from "three/webgpu"
    import { vec4 } from "three/tsl"
    import { onDispose, scene } from "@drawcall/glts"
    scene.defaultCamera = new THREE.PerspectiveCamera(35, 1, 0.1, 10)
    scene.background = new THREE.Color("red")
    scene.rendering.shadows = true
    scene.rendering.toneMapping = THREE.LinearToneMapping
    scene.rendering.toneMappingExposure = 2
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.MeshBasicNodeMaterial({ color: "red" }))
    mesh.position.z = -2
    mesh.onBeforeRender = renderer => {
      scene.userData.profile = { shadows: renderer.shadowMap.enabled, exposure: renderer.toneMappingExposure }
    }
    scene.add(mesh)
    onDispose(() => { mesh.geometry.dispose(); mesh.material.dispose() })
    scene.rendering.effects.push(({ input, camera, scene: root, width, height }) => {
      scene.userData.context = { camera: camera === scene.defaultCamera, root: root === scene, width, height }
      return vec4(input.b, input.g, input.r, input.a)
    })
  `);
  await page.goto("/test-harness.html");
  const result = await page.evaluate(async () => {
    const renderer = new window.WebGPURenderer({ canvas: document.createElement("canvas") });
    function error(action: () => void): string {
      try { action(); return ""; }
      catch (error) { return error instanceof Error ? error.message : String(error); }
    }
    const uninitialized = error(() => new window.GLTSRenderer(renderer));
    await renderer.init();
    renderer.setSize(32, 24, false);
    renderer.toneMappingExposure = 0.75;
    renderer.xr.enabled = true;
    const colorSpace = renderer.outputColorSpace;
    const loader = new window.GLTSLoader(new window.LoadingManager());
    const glts = new window.GLTSRenderer(renderer);
    const target = new window.RenderTarget(4, 4);
    try {
      const scene = await loader.loadAsync("/assets/rendering.glts");
      const duplicate = error(() => new window.GLTSRenderer(renderer));
      glts.render(scene);
      const capture = document.createElement("canvas");
      capture.width = 32;
      capture.height = 24;
      const context = capture.getContext("2d");
      if (!context) throw new Error("Missing 2D context for pixel inspection");
      context.drawImage(renderer.domElement, 0, 0);
      const pixel = [...context.getImageData(16, 12, 1, 1).data];
      const host = {
        exposure: renderer.toneMappingExposure,
        shadows: renderer.shadowMap.enabled,
        toneMapping: renderer.toneMapping,
        colorSpace: renderer.outputColorSpace === colorSpace,
        xr: renderer.xr.enabled
      };
      renderer.setRenderTarget(target);
      const targetError = error(() => glts.render(scene));
      renderer.setRenderTarget(null);
      renderer.setViewport(0, 0, 16, 24);
      const viewportError = error(() => glts.render(scene));
      renderer.setViewport(0, 0, 32, 24);
      scene.defaultCamera = undefined;
      scene.add(new window.PerspectiveCamera());
      const cameraError = error(() => glts.render(scene));
      return { uninitialized, duplicate, pixel, host, profile: scene.userData.profile,
        context: scene.userData.context, targetError, viewportError, cameraError };
    } finally {
      renderer.setRenderTarget(null);
      glts.dispose();
      loader.dispose();
      target.dispose();
      await renderer.dispose();
    }
  });
  expect(result).toEqual({
    uninitialized: "GLTSRenderer requires an initialized WebGPURenderer; await renderer.init() first",
    duplicate: "A WebGPURenderer can have only one active GLTSRenderer",
    pixel: [0, 0, 255, 255],
    host: { exposure: 0.75, shadows: false, toneMapping: 0, colorSpace: true, xr: true },
    profile: { exposure: 2, shadows: true },
    context: { camera: true, root: true, width: 32, height: 24 },
    targetError: "GLTS effects require the default framebuffer",
    viewportError: "GLTS effects require a full viewport with scissor testing disabled",
    cameraError: "GLTSRenderer.render() requires a camera or scene.defaultCamera"
  });
});

test("reloads native scene presentation into the stable root", async ({ page }) => {
  await routeScriptRevisions(page, "**/assets/presentation.glts", [
    `
      import * as THREE from "three/webgpu"
      import { color } from "three/tsl"
      import { scene } from "@drawcall/glts"
      scene.background = new THREE.Color("red")
      scene.backgroundNode = color("red")
      scene.environmentNode = color("green")
      scene.fogNode = color("blue")
      scene.userData.nodes = [scene.backgroundNode, scene.environmentNode, scene.fogNode]
      scene.defaultCamera = new THREE.PerspectiveCamera()
      scene.fog = new THREE.Fog("red", 1, 2)
      scene.environmentIntensity = 0.5
      scene.rendering.shadows = true
      scene.rendering.toneMappingExposure = 2
      scene.rendering.effects.push(() => { throw new Error("unused") })
    `,
    `
      import * as THREE from "three/webgpu"
      import { color } from "three/tsl"
      import { scene } from "@drawcall/glts"
      scene.background = new THREE.Color("blue")
      scene.backgroundNode = color("blue")
      scene.userData.backgroundNode = scene.backgroundNode
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
    const backgroundNode = scene.backgroundNode;
    const nodes = [scene.backgroundNode, scene.environmentNode, scene.fogNode]
      .map((node, index) => node === scene.userData.nodes[index]);
    scene.position.x = 7;
    await loader.reload("/assets/presentation.glts");
    const result = {
      background: scene.background && "getHexString" in scene.background
        ? scene.background.getHexString()
        : "",
      defaultCamera: scene.defaultCamera,
      nodes,
      replacedNode: scene.backgroundNode !== backgroundNode && scene.backgroundNode === scene.userData.backgroundNode,
      resetNodes: [scene.environmentNode, scene.fogNode],
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
    nodes: [true, true, true],
    replacedNode: true,
    resetNodes: [undefined, undefined],
    effects: 0,
    environmentIntensity: 1.5,
    exposure: 0.8,
    fogFar: 4,
    position: 7,
    shadows: false,
    stable: true
  });
});

test("rebuilds and disposes effect graphs when cameras, factories, or scripts change", async ({ page }) => {
  const source = `
    import { scene } from "@drawcall/glts"
    import { bloom } from "effects"
    import { Color } from "three/webgpu"
    scene.background = new Color("blue")
    globalThis.__effects ??= { created: 0, disposed: 0 }
    globalThis.__effectFactory ??= ({ input }) => {
      globalThis.__effects.created++
      const output = input.add(bloom(input))
      output.addEventListener("dispose", () => globalThis.__effects.disposed++)
      return output
    }
    scene.rendering.effects.push(globalThis.__effectFactory)
  `;
  await routeScriptRevisions(page, "**/assets/effects.glts", [source, source]);
  await page.goto("/test-harness.html");
  const result = await page.evaluate(async () => {
    const renderer = new window.WebGPURenderer();
    await renderer.init();
    renderer.setSize(16, 16, false);
    const loader = new window.GLTSLoader(new window.LoadingManager(), { modules: { effects: { bloom: window.bloom } } });
    const glts = new window.GLTSRenderer(renderer);
    try {
      const scene = await loader.loadAsync("/assets/effects.glts");
      const camera = new window.PerspectiveCamera();
      const snapshot = () => ({ ...Reflect.get(globalThis, "__effects") });
      glts.render(scene, camera);
      glts.render(scene, camera);
      const reused = snapshot();
      const replacement = camera.clone();
      glts.render(scene, replacement);
      const changedCamera = snapshot();
      const effect = scene.rendering.effects[0];
      if (!effect) throw new Error("Missing effect factory");
      scene.rendering.effects.push(effect);
      glts.render(scene, replacement);
      const changedFactories = snapshot();
      await loader.reload("/assets/effects.glts");
      glts.render(scene, replacement);
      const reloaded = snapshot();
      const other = await loader.loadAsync("/assets/effects.glts");
      glts.render(other, replacement);
      scene.dispose();
      glts.render(other, replacement);
      const survivor = snapshot();
      const capture = document.createElement("canvas");
      capture.width = capture.height = 16;
      const context = capture.getContext("2d");
      if (!context) throw new Error("Missing pixel capture context");
      context.drawImage(renderer.domElement, 0, 0);
      const pixel = [...context.getImageData(8, 8, 1, 1).data];
      other.dispose();
      const disposed = snapshot();
      return { reused, changedCamera, changedFactories, reloaded, survivor, pixel, disposed };
    } finally {
      glts.dispose();
      loader.dispose();
      await renderer.dispose();
    }
  });
  expect(result).toEqual({
    reused: { created: 1, disposed: 0 },
    changedCamera: { created: 2, disposed: 1 },
    changedFactories: { created: 4, disposed: 2 },
    reloaded: { created: 5, disposed: 4 },
    survivor: { created: 6, disposed: 5 },
    pixel: [0, 0, 255, 255],
    disposed: { created: 6, disposed: 6 }
  });
});

test("surfaces failed effects, cleans partial graphs, and renders after a factory is fixed", async ({ page }) => {
  await routeScript(page, "**/assets/failure.glts", `
    import { scene } from "@drawcall/glts"
    scene.userData.disposed = 0
    scene.rendering.effects.push(({ input }) => {
      const output = input.mul(1)
      output.addEventListener("dispose", () => scene.userData.disposed++)
      return output
    }, () => { throw new Error("effect factory failed") })
  `);
  await routeScript(page, "**/assets/invalid.glts", `
    import { scene } from "@drawcall/glts"
    scene.rendering.effects.push(() => null)
  `);
  await routeScript(page, "**/assets/runtime.glts", `
    import { LinearToneMapping } from "three/webgpu"
    import { uniform } from "three/tsl"
    import { scene } from "@drawcall/glts"
    scene.rendering.shadows = true
    scene.rendering.toneMapping = LinearToneMapping
    scene.rendering.toneMappingExposure = 2
    scene.userData.updates = 0
    scene.rendering.effects.push(({ input }) => {
      const gain = uniform(1).onRenderUpdate(() => {
        if (scene.userData.updates++ === 0) throw new Error("effect update failed")
        return 1
      })
      return input.mul(gain)
    })
  `);
  await page.goto("/test-harness.html");
  const result = await page.evaluate(async () => {
    const renderer = new window.WebGPURenderer();
    await renderer.init();
    renderer.setSize(16, 16, false);
    const loader = new window.GLTSLoader(new window.LoadingManager());
    const glts = new window.GLTSRenderer(renderer);
    const camera = new window.PerspectiveCamera();
    function error(action: () => void): string {
      try { action(); return ""; }
      catch (error) { return error instanceof Error ? error.message : String(error); }
    }
    try {
      const scene = await loader.loadAsync("/assets/failure.glts");
      const factoryError = error(() => glts.render(scene, camera));
      const partialDisposals = scene.userData.disposed;
      scene.rendering.effects.pop();
      glts.render(scene, camera);
      scene.dispose();
      const finalDisposals = scene.userData.disposed;
      const disposedError = error(() => glts.render(scene, camera));
      const invalid = await loader.loadAsync("/assets/invalid.glts");
      const invalidError = error(() => glts.render(invalid, camera));
      const runtime = await loader.loadAsync("/assets/runtime.glts");
      renderer.toneMappingExposure = 0.75;
      renderer.xr.enabled = true;
      renderer.autoClear = false;
      const colorSpace = renderer.outputColorSpace;
      const runtimeError = error(() => glts.render(runtime, camera));
      const restored = {
        target: renderer.getRenderTarget(),
        colorSpace: renderer.outputColorSpace === colorSpace,
        exposure: renderer.toneMappingExposure,
        toneMapping: renderer.toneMapping,
        shadows: renderer.shadowMap.enabled,
        xr: renderer.xr.enabled,
        autoClear: renderer.autoClear
      };
      const recoveryError = error(() => glts.render(runtime, camera));
      return { factoryError, partialDisposals, finalDisposals, disposedError, invalidError,
        runtimeError, restored, recoveryError, updates: runtime.userData.updates };
    } finally {
      glts.dispose();
      loader.dispose();
      await renderer.dispose();
    }
  });
  expect(result).toEqual({
    factoryError: "effect factory failed",
    partialDisposals: 1,
    finalDisposals: 2,
    disposedError: expect.stringContaining("GLTS node has been disposed"),
    invalidError: "GLTS effect factories must return a Three.js TSL node",
    runtimeError: "effect update failed",
    restored: { target: null, colorSpace: true, exposure: 0.75, toneMapping: 0,
      shadows: false, xr: true, autoClear: false },
    recoveryError: "",
    updates: 2
  });
});

test("sizes camera projection to the canvas or render target viewport", async ({ page }) => {
  await routeScript(page, "**/assets/projection.glts", `
    import * as THREE from "three/webgpu"
    import { scene } from "@drawcall/glts"
    scene.defaultCamera = new THREE.PerspectiveCamera(50, 1.7, 0.2, 200)
  `);
  await page.goto("/test-harness.html");
  const result = await page.evaluate(async () => {
    const renderer = new window.WebGPURenderer();
    await renderer.init();
    renderer.setPixelRatio(1.25);
    renderer.setSize(320, 160, false);
    const loader = new window.GLTSLoader(new window.LoadingManager());
    const glts = new window.GLTSRenderer(renderer);
    const target = new window.RenderTarget(96, 32);
    try {
      const scene = await loader.loadAsync("/assets/projection.glts");
      const camera = scene.defaultCamera;
      if (!(camera instanceof window.PerspectiveCamera)) throw new Error("Expected perspective camera");
      glts.render(scene);
      const landscape = camera.aspect;
      renderer.setSize(160, 320, false);
      glts.render(scene);
      const portrait = camera.aspect;
      const ortho = new window.OrthographicCamera(1, 5, 6, -2, 0.1, 100);
      ortho.zoom = 1.7;
      glts.render(scene, ortho);
      const narrow = [ortho.left, ortho.right];
      renderer.setViewport(0, 0, 120, 120);
      glts.render(scene, ortho);
      const square = [ortho.left, ortho.right, ortho.top, ortho.bottom, ortho.zoom];
      renderer.setRenderTarget(target);
      glts.render(scene);
      const targetAspect = camera.aspect;
      target.viewport.set(0, 0, 20, 40);
      glts.render(scene);
      return { landscape, portrait, narrow, square, target: targetAspect, targetViewport: camera.aspect,
        lens: [camera.fov, camera.near, camera.far] };
    } finally {
      renderer.setRenderTarget(null);
      glts.dispose();
      loader.dispose();
      target.dispose();
      await renderer.dispose();
    }
  });
  expect(result).toEqual({ landscape: 2, portrait: 0.5, narrow: [1, 5], square: [-1, 7, 6, -2, 1.7],
    target: 3, targetViewport: 0.5, lens: [50, 0.2, 200] });
});
