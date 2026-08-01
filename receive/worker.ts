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

ctx.onmessage = async (e: MessageEvent) => {
  const { id, bmp } = e.data as { id: number; bmp: ImageBitmap };
  try {
    // Tune ZXing options for fast streaming throughput
    const results = await readBarcodes(bmp, {
      formats: ["QRCode"],
      maxNumberOfSymbols: 1,
      tryHarder: false, // Prevents slow deep-scan heuristics on blurry frames
      tryRotate: true,
    });
    const r = results.find((x) => x.isValid && x.bytes.length > 0);
    ctx.postMessage({ id, bytes: r ? r.bytes : null });
  } catch {
    ctx.postMessage({ id, bytes: null });
  } finally {
    // Explicitly release GPU memory allocated by the transferred ImageBitmap
    bmp.close();
  }
};

// Warm up WASM module
void readBarcodes(new ImageData(8, 8), { formats: ["QRCode"] })
  .catch(() => undefined)
  .then(() => ctx.postMessage({ id: -1, bytes: null }));
