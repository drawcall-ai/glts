/// <reference types="@webgpu/types" />

declare module "@drawcall/webgpu" {
  export interface Canvas {
    width: number;
    height: number;
    readPixels(): Promise<Uint8Array>;
    dispose(): Promise<void>;
  }
  export function createCanvas(width: number, height: number): Promise<Canvas>;
  export function requestAdapter(options?: GPURequestAdapterOptions): Promise<GPUAdapter | null>;
}
