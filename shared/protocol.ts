import { gzip, gunzip } from "fflate";

// Frame protocol: every QR frame is fully self-describing, so there is NO
// handshake — the receiver locks onto a stream mid-flight, and a new session
// id on any frame simply starts a fresh transfer.
//
// Layout (little-endian), 20 bytes, followed by `blockLen` payload bytes:
//   0  u8   magic 0xD1
//   1  u8   magic 0x0C
//   2  u16  sessionId   random per sender start
//   4  u32  seq         drives the fountain PRNG (see fountain.ts)
//   8  u16  k           source block count
//  10  u16  blockLen    payload bytes per frame
//  12  u32  totalLen    protected file-container length in bytes
//  16  u32  payloadFnv  FNV-1a of the whole container — verified on completion

export const HEADER_LEN = 20;
export const MAX_FILE_BYTES = 64 * 1024 * 1024;
const FILE_HEADER_LEN = 49;
const MAGIC0 = 0xd1;
const MAGIC1 = 0x0c;
const FILE_MAGIC = new Uint8Array([0x44, 0x43, 0x46, 0x32]); // DCF2
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export type CompressionMode = "none" | "gzip";

export interface PackedOpticalFile {
  container: Uint8Array;
  compression: CompressionMode;
  originalSize: number;
  transmittedSize: number;
}

export interface OpticalFile {
  name: string;
  type: string;
  bytes: Uint8Array;
  sha256: Uint8Array;
  compression: CompressionMode;
  transmittedSize: number;
}

async function digest(bytes: Uint8Array): Promise<Uint8Array> {
  const stableBytes = Uint8Array.from(bytes);
  return new Uint8Array(await crypto.subtle.digest("SHA-256", stableBytes));
}

function gzipAsync(bytes: Uint8Array): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    gzip(bytes, { level: 9, mem: 12, mtime: 0 }, (error, compressed) => {
      if (error) reject(error);
      else resolve(compressed);
    });
  });
}

function gunzipAsync(bytes: Uint8Array): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    gunzip(bytes, (error, decompressed) => {
      if (error) reject(error);
      else resolve(decompressed);
    });
  });
}

export async function packFile(
  name: string,
  type: string,
  bytes: Uint8Array,
): Promise<PackedOpticalFile> {
  if (bytes.length === 0) throw new Error("Choose a non-empty file.");
  if (bytes.length > MAX_FILE_BYTES) {
    throw new Error("Files are limited to 64 MB in this browser build.");
  }

  const safeName = name.split(/[\\/]/).pop() || "transfer.bin";
  const nameBytes = textEncoder.encode(safeName);
  const typeBytes = textEncoder.encode(type || "application/octet-stream");
  if (nameBytes.length > 0xffff || typeBytes.length > 0xffff) {
    throw new Error("The file name or media type is too long.");
  }

  const [sha256, compressed] = await Promise.all([
    digest(bytes),
    bytes.length >= 768 ? gzipAsync(bytes) : Promise.resolve(undefined),
  ]);
  const useGzip = compressed !== undefined && compressed.length + 64 < bytes.length;
  const transmitted = useGzip ? compressed : bytes;
  const compression: CompressionMode = useGzip ? "gzip" : "none";
  const out = new Uint8Array(
    FILE_HEADER_LEN + nameBytes.length + typeBytes.length + transmitted.length,
  );
  const view = new DataView(out.buffer);
  out.set(FILE_MAGIC, 0);
  view.setUint8(4, useGzip ? 1 : 0);
  view.setUint16(5, nameBytes.length, true);
  view.setUint16(7, typeBytes.length, true);
  view.setUint32(9, bytes.length, true);
  view.setUint32(13, transmitted.length, true);
  out.set(sha256, 17);
  out.set(nameBytes, FILE_HEADER_LEN);
  out.set(typeBytes, FILE_HEADER_LEN + nameBytes.length);
  out.set(transmitted, FILE_HEADER_LEN + nameBytes.length + typeBytes.length);
  return {
    container: out,
    compression,
    originalSize: bytes.length,
    transmittedSize: transmitted.length,
  };
}

export async function unpackFile(container: Uint8Array): Promise<OpticalFile> {
  if (container.length < FILE_HEADER_LEN) throw new Error("The recovered file header is incomplete.");
  for (let i = 0; i < FILE_MAGIC.length; i++) {
    if (container[i] !== FILE_MAGIC[i]) throw new Error("The recovered file header is invalid.");
  }

  const view = new DataView(container.buffer, container.byteOffset, container.byteLength);
  const compressionByte = view.getUint8(4);
  if (compressionByte > 1) throw new Error("The recovered file uses unsupported compression.");
  const compression: CompressionMode = compressionByte === 1 ? "gzip" : "none";
  const nameLength = view.getUint16(5, true);
  const typeLength = view.getUint16(7, true);
  const fileLength = view.getUint32(9, true);
  const transmittedLength = view.getUint32(13, true);
  const dataOffset = FILE_HEADER_LEN + nameLength + typeLength;
  if (
    fileLength === 0 ||
    fileLength > MAX_FILE_BYTES ||
    transmittedLength === 0 ||
    transmittedLength > MAX_FILE_BYTES ||
    dataOffset + transmittedLength !== container.length
  ) {
    throw new Error("The recovered file length does not match its header.");
  }

  const transmitted = container.slice(dataOffset);
  if (compression === "gzip") {
    if (transmitted.length < 18) throw new Error("The recovered gzip payload is incomplete.");
    const trailer = new DataView(
      transmitted.buffer,
      transmitted.byteOffset + transmitted.byteLength - 4,
      4,
    );
    if (trailer.getUint32(0, true) !== fileLength) {
      throw new Error("The gzip payload length does not match its file header.");
    }
  }
  const bytes = compression === "gzip" ? await gunzipAsync(transmitted) : transmitted;
  if (bytes.length !== fileLength) {
    throw new Error("The decompressed file length does not match its header.");
  }

  return {
    name: textDecoder.decode(container.subarray(FILE_HEADER_LEN, FILE_HEADER_LEN + nameLength)) || "transfer.bin",
    type:
      textDecoder.decode(container.subarray(FILE_HEADER_LEN + nameLength, dataOffset)) ||
      "application/octet-stream",
    sha256: container.slice(17, 49),
    bytes,
    compression,
    transmittedSize: transmittedLength,
  };
}

export async function verifyFile(file: OpticalFile): Promise<boolean> {
  const actual = await digest(file.bytes);
  return actual.every((value, index) => value === file.sha256[index]);
}

export interface FrameHeader {
  sessionId: number;
  seq: number;
  k: number;
  blockLen: number;
  totalLen: number;
  payloadFnv: number;
}

export function packFrame(h: FrameHeader, block: Uint8Array): Uint8Array {
  const out = new Uint8Array(HEADER_LEN + block.length);
  const dv = new DataView(out.buffer);
  dv.setUint8(0, MAGIC0);
  dv.setUint8(1, MAGIC1);
  dv.setUint16(2, h.sessionId, true);
  dv.setUint32(4, h.seq, true);
  dv.setUint16(8, h.k, true);
  dv.setUint16(10, h.blockLen, true);
  dv.setUint32(12, h.totalLen, true);
  dv.setUint32(16, h.payloadFnv, true);
  out.set(block, HEADER_LEN);
  return out;
}

export function parseFrame(
  bytes: Uint8Array,
): { header: FrameHeader; block: Uint8Array } | null {
  if (bytes.length <= HEADER_LEN) return null;
  if (bytes[0] !== MAGIC0 || bytes[1] !== MAGIC1) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const header: FrameHeader = {
    sessionId: dv.getUint16(2, true),
    seq: dv.getUint32(4, true),
    k: dv.getUint16(8, true),
    blockLen: dv.getUint16(10, true),
    totalLen: dv.getUint32(12, true),
    payloadFnv: dv.getUint32(16, true),
  };
  if (header.k === 0 || header.blockLen === 0 || header.totalLen === 0) return null;
  if (bytes.length !== HEADER_LEN + header.blockLen) return null;
  return { header, block: bytes.subarray(HEADER_LEN) };
}

export function fnv1a(bytes: Uint8Array): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i]!;
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** splitmix32 — deterministic across JS engines (integer ops only). */
export function splitmix32(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x9e3779b9) | 0;
    let t = s ^ (s >>> 16);
    t = Math.imul(t, 0x21f0aaad);
    t ^= t >>> 15;
    t = Math.imul(t, 0x735a2d97);
    t ^= t >>> 15;
    return t >>> 0;
  };
}
