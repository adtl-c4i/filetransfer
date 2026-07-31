// Receiver: camera → WASM QR decode in workers → fountain decoder → file.
//
// Field lessons baked in:
// - iOS treats `frameRate: {ideal: 60}` as a suggestion and delivers 30.
//   Demand `exact` first (it works at 1280-wide), fall back to `ideal`.
// - requestVideoFrameCallback chains survive a stopped stream and resume on
//   the next one — a generation counter prevents zombie capture loops.
// - Progress must track frames COLLECTED: LT peeling back-loads its solve
//   cascade, so blocks-solved looks stalled and then teleports to done.

import { LTDecoder } from "../shared/fountain";
import {
  EXPECTED_FOUNTAIN_OVERHEAD,
  estimateTransferProgress,
  formatDuration,
} from "../shared/progress";
import {
  clearStoredNotes,
  deleteStoredNote,
  loadStoredNotes,
  storeReceivedNote,
  unpackPrivateNote,
  type StoredNote,
} from "../shared/notes";
import { fnv1a, parseFrame, unpackFile, verifyFile } from "../shared/protocol";

const transferMode = document.body.dataset.transferMode === "note" ? "note" : "file";
const startBtn = document.getElementById("start") as HTMLButtonElement;
const video = document.getElementById("video") as HTMLVideoElement;
const preview = document.getElementById("preview")!;
const stats = document.getElementById("stats")!;
const progressEl = document.getElementById("progress")!;
const bar = document.getElementById("bar")!;
const progressStatus = document.getElementById("progress-status")!;
const progressLabel = document.getElementById("progress-label")!;
const etaLabel = document.getElementById("eta-label")!;
const result = document.getElementById("result")!;
const settings = document.getElementById("settings") as HTMLDetailsElement;
const metricsEl = document.getElementById("metrics")!;
const diagnosticsEl = document.getElementById("diagnostics") as HTMLDetailsElement | null;
const notesList = document.getElementById("notes-list");
const notesEmpty = document.getElementById("notes-empty");
const clearNotesBtn = document.getElementById("clear-notes") as HTMLButtonElement | null;
const metric = (id: string) => document.getElementById(id)!;

let stream: MediaStream | null = null;
let decoder: LTDecoder | null = null;
let sessionId = 0;
let startTs = 0;
let captureGen = 0;
let done = false;

const workers: Worker[] = [];
const busy: boolean[] = [];
const captureTimes: number[] = [];
const decodeTimes: number[] = [];

startBtn.onclick = () => void start();
clearNotesBtn?.addEventListener("click", () => {
  if (!window.confirm("Delete every note stored in this browser?")) return;
  clearStoredNotes(localStorage);
  renderStoredNotes();
});
if (transferMode === "note") renderStoredNotes();

async function start() {
  if (!navigator.mediaDevices?.getUserMedia) {
    // On insecure origins the API doesn't exist AT ALL — this is the plain-
    // http-over-LAN case. localhost is exempt; other hosts need https.
    stats.textContent =
      "✗ camera needs a secure context — this page must be served over " +
      "https to use the camera from another device (npm run dev:https).";
    return;
  }
  const captureWidth = Number((document.getElementById("cfg-width") as HTMLSelectElement).value);
  const captureFps = Number((document.getElementById("cfg-capfps") as HTMLSelectElement).value);
  const workerCount = Number((document.getElementById("cfg-workers") as HTMLSelectElement).value);
  settings.style.display = "none";
  startBtn.style.display = "none";
  preview.style.display = "block";
  metricsEl.style.display = "grid";
  if (diagnosticsEl) diagnosticsEl.style.display = "block";
  const base: MediaTrackConstraints = {
    facingMode: "environment",
    width: { ideal: captureWidth },
    height: { ideal: Math.round((captureWidth * 3) / 4) },
  };
  try {
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { ...base, frameRate: { exact: captureFps } },
      });
    } catch {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { ...base, frameRate: { ideal: captureFps } },
      });
    }
  } catch (err) {
    stats.textContent = `✗ camera: ${err instanceof Error ? err.message : String(err)}`;
    return;
  }
  video.srcObject = stream;
  await video.play().catch(() => undefined);
  stats.textContent = `camera ${stream.getVideoTracks()[0]?.getSettings().width}×${stream.getVideoTracks()[0]?.getSettings().height}@${stream.getVideoTracks()[0]?.getSettings().frameRate} — searching for a stream…`;

  for (let i = 0; i < workerCount; i++) {
    const w = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    const slot = i;
    w.onmessage = (e: MessageEvent) => {
      const { id, bytes } = e.data as { id: number; bytes: Uint8Array | null };
      if (id === -1) return; // warm-up
      busy[slot] = false;
      if (bytes) onDecoded(bytes);
    };
    workers.push(w);
    busy.push(false);
  }

  captureGen++;
  scheduleFrame(captureGen);
  setInterval(updateStats, 500);
  try {
    await (navigator as Navigator & { wakeLock?: { request(t: "screen"): Promise<unknown> } })
      .wakeLock?.request("screen");
  } catch {
    /* fine */
  }
}

type VideoRVFC = HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number };

function scheduleFrame(gen: number) {
  if (done || gen !== captureGen) return;
  const v = video as VideoRVFC;
  const next = () => {
    if (done || gen !== captureGen) return;
    captureFrame();
    scheduleFrame(gen);
  };
  if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(next);
  else requestAnimationFrame(next);
}

const grab = document.createElement("canvas");
let frameId = 0;

function captureFrame() {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return;
  captureTimes.push(performance.now());
  const slot = busy.indexOf(false);
  if (slot === -1) return; // all workers busy — drop the frame, no harm done
  if (grab.width !== vw || grab.height !== vh) {
    grab.width = vw;
    grab.height = vh;
  }
  const ctx = grab.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(video, 0, 0);
  const img = ctx.getImageData(0, 0, vw, vh);
  busy[slot] = true;
  workers[slot]!.postMessage({ id: frameId++, buf: img.data.buffer, w: vw, h: vh }, [
    img.data.buffer,
  ]);
}

function onDecoded(bytes: Uint8Array) {
  decodeTimes.push(performance.now());
  const parsed = parseFrame(bytes);
  if (!parsed || done) return;
  const { header, block } = parsed;
  if (!decoder || sessionId !== header.sessionId) {
    decoder = new LTDecoder(header.k, header.blockLen, header.sessionId, header.totalLen);
    sessionId = header.sessionId;
    startTs = performance.now();
    progressEl.style.display = "block";
    progressStatus.style.display = "flex";
  }
  decoder.addFrame(header.seq, block);
  updateProgressEstimate();

  if (decoder.isComplete) {
    const payload = decoder.assemble()!;
    const seconds = (performance.now() - startTs) / 1000;
    const ok = fnv1a(payload) === header.payloadFnv;
    void finish(payload, ok, seconds);
  }
}

function updateProgressEstimate() {
  if (!decoder) return;
  const elapsed = Math.max(0, (performance.now() - startTs) / 1000);
  const estimate = estimateTransferProgress(decoder.k, decoder.framesNew, elapsed);
  const percent = estimate.fraction * 100;
  const shownPercent = percent < 10 ? percent.toFixed(1) : percent.toFixed(0);
  bar.style.width = `${percent.toFixed(1)}%`;
  progressEl.setAttribute("aria-valuenow", String(Math.floor(percent)));
  progressLabel.textContent =
    `${shownPercent}% · ${decoder.framesNew}/${estimate.targetFrames} unique frames`;
  etaLabel.textContent = estimate.finishing
    ? "Finishing recovery…"
    : estimate.etaSeconds === undefined
      ? "Estimating time…"
      : `About ${formatDuration(estimate.etaSeconds)} remaining`;
}

async function finish(container: Uint8Array, hashOk: boolean, seconds: number) {
  done = true;
  captureGen++;
  stream?.getTracks().forEach((t) => t.stop());
  preview.style.display = "none";
  bar.style.width = "100%";
  progressEl.setAttribute("aria-valuenow", "100");
  progressLabel.textContent = `100% · ${transferMode === "note" ? "note" : "file"} recovered`;
  etaLabel.textContent = `${formatDuration(seconds)} total`;
  try {
    if (!hashOk) throw new Error("The optical stream checksum did not match.");
    if (transferMode === "note") {
      const { note, file } = await unpackPrivateNote(container);
      const stored = storeReceivedNote(localStorage, note);
      const rate = (container.length / 1024 / seconds).toFixed(1);
      stats.textContent =
        `${stored.added ? "note saved" : "note already saved"} · ${seconds.toFixed(1)} s · ` +
        `${rate} KB/s · ${file.compression === "gzip" ? "gzip · " : ""}SHA-256 verified ✓`;
      renderStoredNotes();
      showReceivedNote(note.text, stored.added);
      return;
    }
    const file = await unpackFile(container);
    if (!(await verifyFile(file))) throw new Error("The recovered file failed SHA-256 verification.");

    const kb = Math.round(file.bytes.length / 1024);
    const rate = (container.length / 1024 / seconds).toFixed(1);
    stats.textContent =
      `${kb} KB in ${seconds.toFixed(1)} s · ${rate} KB/s · ` +
      `${file.compression === "gzip" ? "gzip decompressed · " : ""}SHA-256 verified ✓`;
    const heading = document.createElement("div");
    heading.className = "done";
    heading.textContent = "Transfer Complete!";
    const url = URL.createObjectURL(new Blob([file.bytes as BlobPart], { type: file.type }));
    const download = document.createElement("a");
    download.className = "download";
    download.href = url;
    download.download = file.name;
    download.textContent = `Save ${file.name}`;
    result.replaceChildren(heading, download);
    if (file.type.startsWith("image/")) {
      const image = document.createElement("img");
      image.className = "received";
      image.alt = `Received file preview: ${file.name}`;
      image.src = url;
      result.append(image);
    }
  } catch (error) {
    bar.classList.add("error");
    etaLabel.textContent = "Transfer failed";
    stats.textContent = `✗ ${error instanceof Error ? error.message : String(error)}`;
  }
}

function showReceivedNote(text: string, added: boolean) {
  const heading = document.createElement("div");
  heading.className = "done";
  heading.textContent = added ? "Note saved" : "Note already saved";
  const previewText = document.createElement("p");
  previewText.className = "received-note";
  previewText.textContent = text;
  const another = document.createElement("button");
  another.className = "secondary-button";
  another.type = "button";
  another.textContent = "Receive another note";
  another.addEventListener("click", () => window.location.reload());
  result.replaceChildren(heading, previewText, another);
}

function formatNoteTime(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(timestamp));
}

function renderStoredNotes() {
  if (!notesList || !notesEmpty) return;
  const notes = loadStoredNotes(localStorage);
  notesEmpty.style.display = notes.length === 0 ? "block" : "none";
  if (clearNotesBtn) clearNotesBtn.disabled = notes.length === 0;
  notesList.replaceChildren(...notes.map(renderStoredNote));
}

function renderStoredNote(note: StoredNote): HTMLElement {
  const card = document.createElement("article");
  card.className = "note-card";

  const meta = document.createElement("div");
  meta.className = "note-meta";
  const time = document.createElement("time");
  time.dateTime = new Date(note.receivedAt).toISOString();
  time.textContent = `Received ${formatNoteTime(note.receivedAt)}`;
  meta.append(time);

  const text = document.createElement("p");
  text.textContent = note.text;

  const actions = document.createElement("div");
  actions.className = "note-actions";
  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "text-button";
  copy.textContent = "Copy";
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(note.text);
      copy.textContent = "Copied";
      setTimeout(() => { copy.textContent = "Copy"; }, 1500);
    } catch {
      copy.textContent = "Copy failed";
    }
  });
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "text-button danger";
  remove.textContent = "Delete";
  remove.addEventListener("click", () => {
    deleteStoredNote(localStorage, note.id);
    renderStoredNotes();
  });
  actions.append(copy, remove);
  card.append(meta, text, actions);
  return card;
}

function updateStats() {
  if (done) return;
  const now = performance.now();
  const prune = (a: number[]) => {
    while (a.length > 0 && a[0]! < now - 2000) a.shift();
  };
  prune(captureTimes);
  prune(decodeTimes);
  metric("m-cap").textContent = (captureTimes.length / 2).toFixed(0);
  metric("m-dec").textContent = (decodeTimes.length / 2).toFixed(1);
  if (!decoder) return;
  const elapsed = (now - startTs) / 1000;
  updateProgressEstimate();
  const kbs =
    (decoder.framesNew * decoder.blockLen) /
    EXPECTED_FOUNTAIN_OVERHEAD /
    1024 /
    Math.max(0.1, elapsed);
  metric("m-rate").textContent = `${kbs.toFixed(1)} KB/s`;
  metric("m-time").textContent = `${elapsed.toFixed(0)} s`;
  metric("m-frames").textContent = `${decoder.framesNew}/${decoder.framesDup}`;
  metric("m-k").textContent = String(decoder.k);
  metric("m-block").textContent = `${decoder.blockLen} B`;
  metric("m-payload").textContent = `${Math.round(decoder.totalLen / 1024)} KB`;
}
