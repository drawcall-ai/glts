import { GLTSLoader, GLTSRenderer } from "@drawcall/glts";
import { useEffect, useState, type ReactElement } from "react";
import * as THREE from "three/webgpu";

/** The fields of react-native-enriched-markdown's `MarkdownImageBlock` that a GLTS image reads. */
export interface GLTSImageBlock {
  readonly url: string;
  readonly altText: string;
}

/** Draws a standalone `![alt](asset.glts)` image as its GLTS asset; returns undefined for any other image. */
export function renderGLTSImage(block: GLTSImageBlock): ReactElement | undefined {
  if (!/\.glts(?:[?#]|$)/i.test(block.url)) return undefined;
  // Keyed by URL, so another asset starts without the previous one's error.
  return <GLTSCanvas key={block.url} url={block.url} label={block.altText} />;
}

function GLTSCanvas({ url, label }: { url: string; label: string }): ReactElement {
  const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null);
  const [error, setError] = useState<unknown>();

  useEffect(() => canvas ? show(canvas, url, setError) : undefined, [canvas, url]);

  if (error !== undefined) return <pre role="alert">{error instanceof Error ? error.message : String(error)}</pre>;
  return <canvas ref={setCanvas} role="img" aria-label={label} style={{ display: "block", width: "100%", aspectRatio: "16 / 9" }} />;
}

/** Renders the asset at `url` into `canvas` every frame until the returned function stops it and frees everything. */
function show(canvas: HTMLCanvasElement, url: string, onError: (error: unknown) => void): () => void {
  let stopped = false;
  const renderer = new THREE.WebGPURenderer({ canvas, antialias: true });
  const loader = new GLTSLoader(new THREE.LoadingManager(), { isPreview: true });
  const resize = new ResizeObserver(() => renderer.setSize(canvas.clientWidth, canvas.clientHeight, false));
  // Used when the asset has no defaultCamera, placed as the GLTS viewer places its own.
  const camera = new THREE.PerspectiveCamera(35, 1, 0.05, 200);
  camera.position.set(4.6, 2.8, 5.8);
  camera.lookAt(0, 0.8, 0);
  let gltsRenderer: GLTSRenderer | undefined;

  const start = async (): Promise<void> => {
    await renderer.init();
    if (stopped) return;
    const frameRenderer = new GLTSRenderer(renderer);
    gltsRenderer = frameRenderer;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    resize.observe(canvas);
    const scene = await loader.loadAsync(url);
    if (stopped) return;
    const timer = new THREE.Timer();
    // Timed by the timer's own clock: a frame's timestamp can precede the timer's creation, giving a negative delta.
    renderer.setAnimationLoop(() => {
      timer.update();
      try {
        scene.update(timer.getDelta());
        frameRenderer.render(scene, scene.defaultCamera ?? camera);
      } catch (error) {
        renderer.setAnimationLoop(null);
        onError(error);
      }
    });
  };

  const started = start();
  started.catch((error: unknown) => {
    if (!stopped) onError(error);
  });

  return () => {
    stopped = true;
    resize.disconnect();
    renderer.setAnimationLoop(null);
    // Disposing the loader ends a pending load along with every scene it loaded.
    loader.dispose();
    // The renderer is freed only once its initialization settles, which disposal must not race.
    const free = (): void => {
      gltsRenderer?.dispose();
      renderer.dispose();
    };
    started.then(free, free);
  };
}
