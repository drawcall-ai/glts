import { readImageBitmap } from "@drawcall/webgpu";
import { Canvas as NativeCanvas, ImageData, type SKRSContext2D } from "@napi-rs/canvas";

/** Canvases of the ImageBitmaps 2D canvases drew, made on the first draw: most bitmaps are only uploaded as textures. */
const drawable = new WeakMap<ImageBitmap, NativeCanvas>();
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
      // Outside a headless session, such as when exporting a scene directly, there is no ImageBitmap.
      const bitmap = typeof ImageBitmap !== "undefined" && image instanceof ImageBitmap;
      Reflect.apply(drawImage, context, [bitmap ? canvasOf(image) : image, ...rest]);
    },
  });
  Object.defineProperty(context, "getImageData", {
    value: (x: number, y: number, width: number, height: number, settings?: ImageDataSettings): ImageData => {
      if ((settings?.colorSpace ?? "srgb") !== "srgb") throw new Error(`Headless 2D canvases read only sRGB image data, not ${settings?.colorSpace}`);
      return getImageData.call(context, x, y, width, height);
    },
  });
}

function canvasOf(bitmap: ImageBitmap): NativeCanvas {
  // Closing empties a bitmap; drawing it then fails, as in browsers, rather than drawing the cached copy.
  if (bitmap.width === 0) throw new DOMException("The ImageBitmap is closed", "InvalidStateError");
  let canvas = drawable.get(bitmap);
  if (canvas) return canvas;
  const { data, width, height } = readImageBitmap(bitmap);
  canvas = new NativeCanvas(width, height);
  canvas.getContext("2d").putImageData(new ImageData(data, width, height), 0, 0);
  drawable.set(bitmap, canvas);
  return canvas;
}
