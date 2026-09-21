/**
 * A minimal ZIP reader (enough for .xlsx files) without libraries. Uses the browser's built-in DecompressionStream.
 * Guards against ZIP bombs: limits on the number of entries and on the size after unpacking.
 */
const MAX_ENTRIES = 500;
const MAX_UNPACKED_BYTES = 40 * 1024 * 1024;

const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

/** Lists the files in a zip: [{ name, method, compressedSize, size, offset }]. */
export function listZip(buffer) {
  const b = new Uint8Array(buffer);
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 65535); i--) {
    if (u32(b, i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("This file is not a valid Excel (.xlsx) file.");
  const count = u16(b, eocd + 10);
  let p = u32(b, eocd + 16);
  if (count === 0xffff || p === 0xffffffff) throw new Error("This Excel file is too large or uses an unsupported format.");
  if (count > MAX_ENTRIES) throw new Error("This Excel file has too many parts.");
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (u32(b, p) !== 0x02014b50) throw new Error("This file is not a valid Excel (.xlsx) file.");
    const nameLength = u16(b, p + 28);
    const extraLength = u16(b, p + 30);
    const commentLength = u16(b, p + 32);
    entries.push({
      method: u16(b, p + 10),
      compressedSize: u32(b, p + 20),
      size: u32(b, p + 24),
      offset: u32(b, p + 42),
      name: new TextDecoder().decode(b.subarray(p + 46, p + 46 + nameLength)),
    });
    p += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** Unpacks one entry to bytes. */
export async function readZipEntry(buffer, entry) {
  const b = new Uint8Array(buffer);
  if (entry.size > MAX_UNPACKED_BYTES) throw new Error("This Excel file is too large.");
  const p = entry.offset;
  if (u32(b, p) !== 0x04034b50) throw new Error("This file is not a valid Excel (.xlsx) file.");
  const start = p + 30 + u16(b, p + 26) + u16(b, p + 28);
  const data = b.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return data;
  if (entry.method !== 8) throw new Error("This Excel file uses an unsupported compression.");
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  const out = new Uint8Array(await new Response(stream).arrayBuffer());
  if (out.length > MAX_UNPACKED_BYTES) throw new Error("This Excel file is too large.");
  return out;
}
