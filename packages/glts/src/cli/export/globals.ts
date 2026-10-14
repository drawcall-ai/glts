import { Canvas, ImageData } from "@napi-rs/canvas";

export class ExportCanvas extends Canvas {
  constructor(width: number, height: number) {
    super(width, height);
    // Canvas.data() otherwise makes GLTFExporter mistake the canvas for a DataTexture.
    Object.defineProperty(this, "data", { value: undefined });
  }
}

class BlobReader {
  result: ArrayBuffer | undefined;
  onloadend: (() => void) | undefined;

  readAsArrayBuffer(blob: Blob): void {
    void blob.arrayBuffer().then((buffer) => {
      this.result = buffer;
      this.onloadend?.();
    });
  }
}

/** GLTFExporter uses browser globals; keep these adapters inside the CLI worker. */
export function installExportGlobals(): () => void {
  const values = { document: undefined, OffscreenCanvas: ExportCanvas, ImageData, FileReader: BlobReader };
  const descriptors = Object.keys(values).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  for (const [key, value] of Object.entries(values)) {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  return () => {
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  };
}
