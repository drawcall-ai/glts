import { Canvas as NativeCanvas } from "@napi-rs/canvas";

/** A native 2D canvas that Three's texture exporter does not mistake for a DataTexture. */
export class Canvas extends NativeCanvas {
  constructor(width: number, height: number) {
    super(width, height);
    Object.defineProperty(this, "data", { value: undefined });
  }
}
