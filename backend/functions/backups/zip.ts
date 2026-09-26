/**
 * A minimal ZIP writer, no dependencies: every entry is stored (method 0) with its CRC-32 and sizes.
 *
 * Store-only on purpose. The archive holds one JSON document (small) and the question's images and audio,
 * which are already compressed — running DEFLATE over them would buy almost nothing — and "stored" is the
 * one shape every unzip tool reads back, which is the whole point of a backup file. The live backup check
 * opens a produced archive with Python's `zipfile` (a third-party reader) to prove that.
 */
export interface ZipEntry {
  name: string;
  bytes: Uint8Array;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

/** The standard CRC-32 (the one ZIP uses). */
export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const MAX_U32 = 0xffffffff;

/** Builds a complete .zip: local headers + data, the central directory, and the end record. */
export function zipStore(entries: ZipEntry[], now = new Date()): Uint8Array {
  if (entries.length > 0xffff) throw new Error("A zip file can hold at most 65535 entries.");
  const encoder = new TextEncoder();
  const { time, date } = dosStamp(now);

  const prepared = entries.map((e) => {
    const name = encoder.encode(e.name);
    if (name.length === 0 || name.length > 0xffff) throw new Error(`Zip entry name is not valid: ${e.name}`);
    return { name, bytes: e.bytes, crc: crc32(e.bytes) };
  });

  const size = prepared.reduce((n, p) => n + 30 + p.name.length + p.bytes.length + 46 + p.name.length, 22);
  if (size > MAX_U32) throw new Error("This archive is too large for a zip file.");

  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  const offsets: number[] = [];
  let at = 0;

  for (const p of prepared) {
    offsets.push(at);
    view.setUint32(at, 0x04034b50, true); at += 4; // local file header
    view.setUint16(at, 20, true); at += 2; // version needed to extract
    view.setUint16(at, 0x0800, true); at += 2; // names are UTF-8
    view.setUint16(at, 0, true); at += 2; // stored (no compression)
    view.setUint16(at, time, true); at += 2;
    view.setUint16(at, date, true); at += 2;
    view.setUint32(at, p.crc, true); at += 4;
    view.setUint32(at, p.bytes.length, true); at += 4; // compressed size
    view.setUint32(at, p.bytes.length, true); at += 4; // uncompressed size
    view.setUint16(at, p.name.length, true); at += 2;
    view.setUint16(at, 0, true); at += 2; // no extra field
    out.set(p.name, at); at += p.name.length;
    out.set(p.bytes, at); at += p.bytes.length;
  }

  const directoryStart = at;
  prepared.forEach((p, i) => {
    view.setUint32(at, 0x02014b50, true); at += 4; // central directory entry
    view.setUint16(at, 20, true); at += 2; // version made by
    view.setUint16(at, 20, true); at += 2; // version needed
    view.setUint16(at, 0x0800, true); at += 2;
    view.setUint16(at, 0, true); at += 2; // stored
    view.setUint16(at, time, true); at += 2;
    view.setUint16(at, date, true); at += 2;
    view.setUint32(at, p.crc, true); at += 4;
    view.setUint32(at, p.bytes.length, true); at += 4;
    view.setUint32(at, p.bytes.length, true); at += 4;
    view.setUint16(at, p.name.length, true); at += 2;
    view.setUint16(at, 0, true); at += 2; // extra
    view.setUint16(at, 0, true); at += 2; // comment
    view.setUint16(at, 0, true); at += 2; // disk number
    view.setUint16(at, 0, true); at += 2; // internal attributes
    view.setUint32(at, 0, true); at += 4; // external attributes
    view.setUint32(at, offsets[i], true); at += 4; // where the local header starts
    out.set(p.name, at); at += p.name.length;
  });
  const directorySize = at - directoryStart;

  view.setUint32(at, 0x06054b50, true); at += 4; // end of central directory
  view.setUint16(at, 0, true); at += 2;
  view.setUint16(at, 0, true); at += 2;
  view.setUint16(at, prepared.length, true); at += 2;
  view.setUint16(at, prepared.length, true); at += 2;
  view.setUint32(at, directorySize, true); at += 4;
  view.setUint32(at, directoryStart, true); at += 4;
  view.setUint16(at, 0, true); at += 2;

  if (at !== size) throw new Error("The zip writer's size calculation is wrong.");
  return out;
}

/** ZIP stores timestamps in two 16-bit DOS fields (seconds are two-second steps). */
function dosStamp(now: Date): { time: number; date: number } {
  const year = Math.max(1980, now.getUTCFullYear());
  return {
    date: ((year - 1980) << 9) | ((now.getUTCMonth() + 1) << 5) | now.getUTCDate(),
    time: (now.getUTCHours() << 11) | (now.getUTCMinutes() << 5) | Math.floor(now.getUTCSeconds() / 2),
  };
}
