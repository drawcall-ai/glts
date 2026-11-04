import { requestAdapter } from "@drawcall/webgpu";
import { Canvas as NativeCanvas, ImageData, type SKRSContext2D } from "@napi-rs/canvas";
import { readBitmap } from "./bitmap.js";

/**
 * What 2D canvases draw for the native ImageBitmaps createImageBitmap made, which they cannot read themselves: the
 * pixels, replaced by a canvas of them on the first draw, since most bitmaps are only uploaded as textures.
 */
const drawable = new WeakMap<WeakKey, ImageData | NativeCanvas>();
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
      Reflect.apply(drawImage, context, [drawableOf(image), ...rest]);
    },
  });
  Object.defineProperty(context, "getImageData", {
    value: (x: number, y: number, width: number, height: number, settings?: ImageDataSettings): ImageData => {
      if ((settings?.colorSpace ?? "srgb") !== "srgb") throw new Error(`Headless 2D canvases read only sRGB image data, not ${settings?.colorSpace}`);
      return getImageData.call(context, x, y, width, height);
    },
  });
}

/**
 * Lets the GPU copy 2D canvases into textures, as Three uploads CanvasTextures: the native `copyExternalImageToTexture`
 * accepts only ImageBitmaps. The returned function restores it.
 */
export function copyableCanvases(): () => void {
  const { prototype } = GPUQueue;
  const copy = prototype.copyExternalImageToTexture;
  prototype.copyExternalImageToTexture = function (source, destination, size) {
    const canvas = source.source;
    if (canvas instanceof NativeCanvas) writeCanvas(this, { ...source, source: canvas }, destination, size);
    else copy.call(this, source, destination, size);
  };
  return () => { prototype.copyExternalImageToTexture = copy; };
}

/** Copies as `copyExternalImageToTexture` would, for the 8-bit RGBA textures that 2D canvases upload to. */
function writeCanvas(
  queue: GPUQueue,
  { source, origin = [], flipY = false }: GPUCopyExternalImageSourceInfo & { source: NativeCanvas },
  destination: GPUCopyExternalImageDestInfo,
  size: GPUExtent3DStrict,
): void {
  const { format } = destination.texture;
  if (format !== "rgba8unorm" && format !== "rgba8unorm-srgb") throw new Error(`Headless 2D canvases cannot be copied into ${format} textures`);
  if ((destination.colorSpace ?? "srgb") !== "srgb") throw new Error(`Headless 2D canvases copy only into sRGB, not ${destination.colorSpace}`);
  const [x = 0, y = 0] = Symbol.iterator in origin ? origin : [origin.x, origin.y];
  const [width = 0, height = 1, layers = 1] = Symbol.iterator in size ? size : [size.width, size.height, size.depthOrArrayLayers];
  if (layers !== 1) throw new Error("Headless 2D canvases copy into one texture layer at a time");
  const read = source.getContext("2d").getImageData(x, flipY ? source.height - y - height : y, width, height).data;
  const pixels = new Uint8ClampedArray(read);
  const rowBytes = width * 4;
  if (flipY) {
    for (let row = 0; row < height; row++) pixels.set(read.subarray((height - 1 - row) * rowBytes, (height - row) * rowBytes), row * rowBytes);
  }
  if (destination.premultipliedAlpha) {
    for (let i = 0; i < pixels.length; i += 4) {
      const alpha = (pixels[i + 3] ?? 0) / 255;
      for (let channel = i; channel < i + 3; channel++) pixels[channel] = (pixels[channel] ?? 0) * alpha;
    }
  }
  queue.writeTexture(destination, pixels, { bytesPerRow: rowBytes, rowsPerImage: height }, [width, height]);
}

/** What a 2D canvas draws for `image`: a canvas for a headless ImageBitmap, otherwise the image itself. */
function drawableOf(image: unknown): unknown {
  if (typeof image !== "object" || image === null) return image;
  const source = drawable.get(image);
  if (!(source instanceof ImageData)) return source ?? image;
  const canvas = new NativeCanvas(source.width, source.height);
  canvas.getContext("2d").putImageData(source, 0, 0);
  drawable.set(image, canvas);
  return canvas;
}

/** The native function's form; it rejects cropping. */
type CreateImageBitmap = (source: ImageBitmapSource, options?: ImageBitmapOptions) => Promise<ImageBitmap>;

/**
 * Wraps the native `createImageBitmap` so 2D canvases can draw its bitmaps, reading each back from the GPU as it is
 * decoded, since `drawImage` cannot wait for a readback. `dispose` destroys the device that reads them.
 */
export function readableBitmaps(create: CreateImageBitmap): { createImageBitmap: CreateImageBitmap; dispose: () => Promise<void> } {
  let device: Promise<GPUDevice> | undefined;
  const startDevice = async (): Promise<GPUDevice> => {
    const adapter = await requestAdapter();
    if (!adapter) throw new Error("WebGPU is unavailable for reading ImageBitmaps");
    return adapter.requestDevice();
  };
  const createReadable = async (source: ImageBitmapSource, options?: ImageBitmapOptions): Promise<ImageBitmap> => {
    const bitmap = await create(source, options);
    const pixels = new Uint8ClampedArray((await readBitmap(await (device ??= startDevice()), bitmap)).buffer);
    drawable.set(bitmap, new ImageData(pixels, bitmap.width, bitmap.height));
    return bitmap;
  };
  return {
    createImageBitmap: createReadable,
    // A device that failed to start already rejected the createImageBitmap call that requested it.
    dispose: async () => { await device?.then((value) => value.destroy(), () => undefined); },
  };
}
