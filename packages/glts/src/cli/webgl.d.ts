declare module "@drawcall/webgl" {
  export interface Canvas {
    width: number;
    height: number;
    readPixels(out?: Uint8Array): Uint8Array;
    destroy(): void;
  }
  export function createCanvas(width: number, height: number): Canvas;
  export function installGlobals(): void;
}
