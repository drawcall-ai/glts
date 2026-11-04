import { requestAdapter } from "@drawcall/webgpu";
import { Canvas as NativeCanvas, ImageData, type SKRSContext2D } from "@napi-rs/canvas";
import { readBitmap } from "./bitmap.js";

/** The pixels of the native ImageBitmaps createImageBitmap made, which a 2D canvas cannot read from the bitmap itself. */
const bitmaps = new WeakMap<WeakKey, ImageData>();
/** Copies of the bitmaps 2D canvases drew, made on their first draw: most bitmaps are only uploaded as textures. */
const drawable = new WeakMap<ImageData, NativeCanvas>();
const adapted = new WeakSet<SKRSContext2D>();

/**
 * A native 2D canvas, as `document.createElement("canvas")` and `OffscreenCanvas` make, that draws ImageBitmaps and
 * that Three's texture exporter does not mistake for a DataTexture.
 */
export class Canvas extends NativeCanvas {
  constructor(width: number, height: number) {
    super(width, height);
    // The native constructor returns a native canvas instead of this subclass, so the canvas itself is adapted.
    Object.defineProperty(this, "data", { value: undefined });
    // Style assignments, such as Three's on the canvases it creates, are inert without a layout.
    Object.defineProperty(this, "style", { value: {} });
    const getContext = this.getContext.bind(this);
    Object.defineProperty(this, "getContext", {
      value: (type: "2d", attributes?: Parameters<NativeCanvas["getContext"]>[1]): SKRSContext2D => {
        const context = getContext(type, attributes);
        if (!adapted.has(context)) adapt(context);
        return context;
      },
    });
  }
}

/** Lets `context` draw ImageBitmaps and read sRGB image data with the browser's signature. */
function adapt(context: SKRSContext2D): void {
  adapted.add(context);
  const { drawImage, getImageData } = context;
  Object.defineProperty(context, "drawImage", {
    value: (image: unknown, ...rest: number[]): void => {
      const pixels = typeof image === "object" && image !== null ? bitmaps.get(image) : undefined;
      Reflect.apply(drawImage, context, [pixels ? canvasOf(pixels) : image, ...rest]);
    },
  });
  Object.defineProperty(context, "getImageData", {
    value: (x: number, y: number, width: number, height: number, settings?: ImageDataSettings): ImageData => {
      if ((settings?.colorSpace ?? "srgb") !== "srgb") throw new Error(`Headless 2D canvases read only sRGB image data, not ${settings?.colorSpace}`);
      return getImageData.call(context, x, y, width, height);
    },
  });
}

function canvasOf(pixels: ImageData): NativeCanvas {
  let canvas = drawable.get(pixels);
  if (canvas) return canvas;
  canvas = new NativeCanvas(pixels.width, pixels.height);
  canvas.getContext("2d").putImageData(pixels, 0, 0);
  drawable.set(pixels, canvas);
  return canvas;
}

/** The straight-alpha RGBA pixels of a native ImageBitmap the session's createImageBitmap made. */
export function bitmapPixels(image: ImageBitmap): Uint8ClampedArray {
  const pixels = bitmaps.get(image);
  if (!pixels) throw new Error("This ImageBitmap was not decoded by the headless createImageBitmap");
  return pixels.data;
}

/** The native function's form; it rejects cropping. */
type CreateImageBitmap = (source: ImageBitmapSource, options?: ImageBitmapOptions) => Promise<ImageBitmap>;

/**
 * Wraps the native `createImageBitmap` so 2D canvases can draw its bitmaps, reading each back from the GPU as it is
 * decoded, since `drawImage` cannot wait for a readback. `dispose` destroys the device that reads them.
 */
export function readableBitmaps(create: CreateImageBitmap): { createImageBitmap: CreateImageBitmap; dispose: () => Promise<void> } {
  let device: Promise<GPUDevice> | undefined;
  const readback = async (): Promise<GPUDevice> => {
    const adapter = await requestAdapter();
    if (!adapter) throw new Error("WebGPU is unavailable for reading ImageBitmaps");
    return adapter.requestDevice();
  };
  const decode = async (source: ImageBitmapSource, options?: ImageBitmapOptions): Promise<ImageBitmap> => {
    const bitmap = await create(source, options);
    const pixels = new Uint8ClampedArray((await readBitmap(await (device ??= readback()), bitmap)).buffer);
    bitmaps.set(bitmap, new ImageData(pixels, bitmap.width, bitmap.height));
    return bitmap;
  };
  return {
    createImageBitmap: decode,
    // A device that failed to start already rejected the createImageBitmap call that requested it.
    dispose: async () => { await device?.then((value) => value.destroy(), () => undefined); },
  };
}
