// QR decode worker: zxing-cpp compiled to WASM.
import wasmUrl from "zxing-wasm/reader/zxing_reader.wasm?url";
import { prepareZXingModule, readBarcodes } from "zxing-wasm/reader";

prepareZXingModule({
  overrides: {
    locateFile: (path: string, prefix: string) =>
      path.endsWith(".wasm") ? wasmUrl : prefix + path,
  },
});

const ctx = self as unknown as {
  onmessage: ((e: MessageEvent) => void) | null;
  postMessage(msg: unknown, transfer?: Transferable[]): void;
};

let offscreen: OffscreenCanvas | null = null;
let offCtx: OffscreenCanvasRenderingContext2D | null = null;

ctx.onmessage = async (e: MessageEvent) => {
  const { id, bmp } = e.data as { id: number; bmp: ImageBitmap };
  try {
    // Reuse OffscreenCanvas to convert ImageBitmap to ImageData off the main thread
    if (!offscreen || offscreen.width !== bmp.width || offscreen.height !== bmp.height) {
      offscreen = new OffscreenCanvas(bmp.width, bmp.height);
      offCtx = offscreen.getContext("2d", { willReadFrequently: true })!;
    }
    offCtx.drawImage(bmp, 0, 0);
    const imgData = offCtx.getImageData(0, 0, bmp.width, bmp.height);

    const results = await readBarcodes(imgData, {
      formats: ["QRCode"],
      maxNumberOfSymbols: 1,
      tryHarder: false,
      tryRotate: true,
    });
    const r = results.find((x) => x.isValid && x.bytes.length > 0);
    ctx.postMessage({ id, bytes: r ? r.bytes : null });
  } catch {
    ctx.postMessage({ id, bytes: null });
  } finally {
    bmp.close();
  }
};

// Warm up WASM module
void readBarcodes(new ImageData(8, 8), { formats: ["QRCode"] })
  .catch(() => undefined)
  .then(() => ctx.postMessage({ id: -1, bytes: null }));
