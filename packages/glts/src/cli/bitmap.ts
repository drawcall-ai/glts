/** Read a native ImageBitmap for the GLB exporter's 2D canvas, which cannot draw WebGPU's native images. */
export async function readBitmap(device: GPUDevice, image: ImageBitmap): Promise<Uint8Array> {
  const rowBytes = image.width * 4;
  const bytesPerRow = Math.ceil(rowBytes / 256) * 256;
  const texture = device.createTexture({
    size: [image.width, image.height],
    format: "rgba8unorm",
    usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC | GPUTextureUsage.RENDER_ATTACHMENT,
  });
  const buffer = device.createBuffer({
    size: bytesPerRow * image.height,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  try {
    device.queue.copyExternalImageToTexture({ source: image }, { texture }, [image.width, image.height]);
    const encoder = device.createCommandEncoder();
    encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow }, [image.width, image.height]);
    device.queue.submit([encoder.finish()]);
    await buffer.mapAsync(GPUMapMode.READ);
    const mapped = new Uint8Array(buffer.getMappedRange());
    const pixels = new Uint8Array(rowBytes * image.height);
    for (let row = 0; row < image.height; row++) {
      pixels.set(mapped.subarray(row * bytesPerRow, row * bytesPerRow + rowBytes), row * rowBytes);
    }
    return pixels;
  } finally {
    buffer.destroy();
    texture.destroy();
  }
}
