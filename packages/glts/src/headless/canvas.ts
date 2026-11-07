import { createRequire } from "node:module";
import { readImageBitmap } from "@drawcall/webgpu";
import type * as Native from "@napi-rs/canvas";

/** Canvases of the ImageBitmaps 2D canvases drew, made on the first draw: most bitmaps are only uploaded as textures. */
const drawable = new WeakMap<ImageBitmap, Native.Canvas>();
const adapted = new WeakSet<Native.SKRSContext2D>();
let native: typeof Native | undefined;
/** The class of headless 2D canvases, whose instances are native canvases. */
export type CanvasClass = new (width: number, height: number) => Native.Canvas;
let adaptedClass: CanvasClass | undefined;

/** The native 2D canvas library, loaded when first needed: loading it takes a tenth of a second, measured on an M2 Pro. */
export function nativeCanvas(): typeof Native {
  // CommonJS loads synchronously, as scripts make canvases.
  return native ??= createRequire(import.meta.url)("@napi-rs/canvas");
}

/**
 * The class of the native 2D canvases `document.createElement("canvas")` and `OffscreenCanvas` make, which draw
 * ImageBitmaps and which Three's texture exporter does not mistake for DataTextures.
 */
export function canvasClass(): CanvasClass {
  return adaptedClass ??= class Canvas extends nativeCanvas().Canvas {
    constructor(width: number, height: number) {
      super(width, height);
      // The native constructor returns a native canvas instead of this subclass, so the canvas itself is adapted.
      Object.defineProperty(this, "data", { value: undefined });
      // Style assignments, such as Three's on the canvases it creates, are inert without a layout.
      Object.defineProperty(this, "style", { value: {} });
      const getContext = this.getContext.bind(this);
      Object.defineProperty(this, "getContext", {
        value: (type: "2d", attributes?: Parameters<Native.Canvas["getContext"]>[1]): Native.SKRSContext2D => {
          const context = getContext(type, attributes);
          if (!adapted.has(context)) adapt(context);
          return context;
        },
      });
    }
  };
}

/** Lets `context` draw ImageBitmaps and read sRGB image data with the browser's signature. */
function adapt(context: Native.SKRSContext2D): void {
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
    value: (x: number, y: number, width: number, height: number, settings?: ImageDataSettings): Native.ImageData => {
      if ((settings?.colorSpace ?? "srgb") !== "srgb") throw new Error(`Headless 2D canvases read only sRGB image data, not ${settings?.colorSpace}`);
      return getImageData.call(context, x, y, width, height);
    },
  });
}

function canvasOf(bitmap: ImageBitmap): Native.Canvas {
  // Closing empties a bitmap; drawing it then fails, as in browsers, rather than drawing the cached copy.
  if (bitmap.width === 0) throw new DOMException("The ImageBitmap is closed", "InvalidStateError");
  let canvas = drawable.get(bitmap);
  if (canvas) return canvas;
  const { data, width, height } = readImageBitmap(bitmap);
  const { Canvas, ImageData } = nativeCanvas();
  canvas = new Canvas(width, height);
  canvas.getContext("2d").putImageData(new ImageData(data, width, height), 0, 0);
  drawable.set(bitmap, canvas);
  return canvas;
}
