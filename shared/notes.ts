import {
  packFile,
  unpackFile,
  verifyFile,
  type OpticalFile,
  type PackedOpticalFile,
} from "./protocol";

export const NOTE_MEDIA_TYPE = "application/vnd.decimen.note+json";
export const MAX_NOTE_BYTES = 256 * 1024;
export const NOTE_STORAGE_KEY = "decimen.private-notes.v1";
export const MAX_STORED_NOTES = 100;

export interface PrivateNote {
  version: 1;
  id: string;
  text: string;
  createdAt: number;
}

export interface StoredNote extends PrivateNote {
  receivedAt: number;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

function isPrivateNote(value: unknown): value is PrivateNote {
  if (!value || typeof value !== "object") return false;
  const note = value as Partial<PrivateNote>;
  return (
    note.version === 1 &&
    typeof note.id === "string" &&
    note.id.length > 0 &&
    note.id.length <= 128 &&
    typeof note.text === "string" &&
    Number.isFinite(note.createdAt) &&
    (note.createdAt ?? 0) > 0 &&
    encoder.encode(note.text).length <= MAX_NOTE_BYTES
  );
}

function isStoredNote(value: unknown): value is StoredNote {
  return (
    isPrivateNote(value) &&
    Number.isFinite((value as Partial<StoredNote>).receivedAt) &&
    ((value as Partial<StoredNote>).receivedAt ?? 0) > 0
  );
}

export async function packPrivateNote(
  text: string,
  createdAt = Date.now(),
  id = crypto.randomUUID(),
): Promise<{ note: PrivateNote; packed: PackedOpticalFile }> {
  if (text.trim().length === 0) throw new Error("Write a note before sending it.");
  if (encoder.encode(text).length > MAX_NOTE_BYTES) {
    throw new Error("Private notes are limited to 256 KB.");
  }
  const note: PrivateNote = { version: 1, id, text, createdAt };
  const bytes = encoder.encode(JSON.stringify(note));
  const packed = await packFile("private-note.decimen-note", NOTE_MEDIA_TYPE, bytes);
  return { note, packed };
}

export async function unpackPrivateNote(
  container: Uint8Array,
): Promise<{ note: PrivateNote; file: OpticalFile }> {
  const file = await unpackFile(container);
  if (file.type !== NOTE_MEDIA_TYPE) {
    throw new Error("This is a file stream. Open Receive file instead.");
  }
  if (!(await verifyFile(file))) {
    throw new Error("The recovered note failed SHA-256 verification.");
  }
  let value: unknown;
  try {
    value = JSON.parse(decoder.decode(file.bytes));
  } catch {
    throw new Error("The recovered note is not valid UTF-8 JSON.");
  }
  if (!isPrivateNote(value)) throw new Error("The recovered note is invalid.");
  return { note: value, file };
}

export function loadStoredNotes(storage: StorageLike): StoredNote[] {
  try {
    const raw = storage.getItem(NOTE_STORAGE_KEY);
    if (!raw) return [];
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return value.filter(isStoredNote).slice(0, MAX_STORED_NOTES);
  } catch {
    return [];
  }
}

export function storeReceivedNote(
  storage: StorageLike,
  note: PrivateNote,
  receivedAt = Date.now(),
): { notes: StoredNote[]; added: boolean } {
  const current = loadStoredNotes(storage);
  if (current.some((item) => item.id === note.id)) return { notes: current, added: false };
  const notes = [{ ...note, receivedAt }, ...current].slice(0, MAX_STORED_NOTES);
  storage.setItem(NOTE_STORAGE_KEY, JSON.stringify(notes));
  return { notes, added: true };
}

export function deleteStoredNote(storage: StorageLike, id: string): StoredNote[] {
  const notes = loadStoredNotes(storage).filter((note) => note.id !== id);
  storage.setItem(NOTE_STORAGE_KEY, JSON.stringify(notes));
  return notes;
}

export function clearStoredNotes(storage: StorageLike): void {
  storage.removeItem(NOTE_STORAGE_KEY);
}
