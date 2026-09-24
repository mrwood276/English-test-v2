/**
 * A minimal ZIP writer (enough for an .xlsx package) without libraries — the counterpart of the reader in
 * `../import/zip.js`. Entries are stored uncompressed (method 0): an export is a few kilobytes of text, and a
 * stored archive can be read by every zip tool and verified without a decompressor. The file dates are fixed
 * (1980-01-01) so the same table always produces the same bytes.
 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Builds a zip archive from [{ name, text }] and returns its bytes. */
export function zipStore(entries) {
  const encoder = new TextEncoder();
  const locals = [];
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const data = encoder.encode(entry.text);
    const crc = crc32(data);

    const local = new Uint8Array(30 + name.length + data.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);   // local file header
    localView.setUint16(4, 20, true);           // version needed
    localView.setUint16(6, 0, true);            // flags
    localView.setUint16(8, 0, true);            // method 0: stored
    localView.setUint16(10, 0, true);           // time
    localView.setUint16(12, 0x0021, true);      // date: 1980-01-01
    localView.setUint32(14, crc, true);
    localView.setUint32(18, data.length, true); // compressed size
    localView.setUint32(22, data.length, true); // uncompressed size
    localView.setUint16(26, name.length, true);
    localView.setUint16(28, 0, true);           // extra length
    local.set(name, 30);
    local.set(data, 30 + name.length);
    locals.push(local);

    const dir = new Uint8Array(46 + name.length);
    const dirView = new DataView(dir.buffer);
    dirView.setUint32(0, 0x02014b50, true);     // central directory entry
    dirView.setUint16(4, 20, true);             // version made by
    dirView.setUint16(6, 20, true);             // version needed
    dirView.setUint16(8, 0, true);              // flags
    dirView.setUint16(10, 0, true);             // method
    dirView.setUint16(12, 0, true);             // time
    dirView.setUint16(14, 0x0021, true);        // date
    dirView.setUint32(16, crc, true);
    dirView.setUint32(20, data.length, true);   // compressed size
    dirView.setUint32(24, data.length, true);   // uncompressed size
    dirView.setUint16(28, name.length, true);
    dirView.setUint16(30, 0, true);             // extra length
    dirView.setUint16(32, 0, true);             // comment length
    dirView.setUint16(34, 0, true);             // disk number
    dirView.setUint16(36, 0, true);             // internal attributes
    dirView.setUint32(38, 0, true);             // external attributes
    dirView.setUint32(42, offset, true);        // where the local header starts
    dir.set(name, 46);
    central.push(dir);

    offset += local.length;
  }

  const centralSize = central.reduce((sum, part) => sum + part.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);       // end of central directory
  endView.setUint16(8, entries.length, true);   // entries on this disk
  endView.setUint16(10, entries.length, true);  // entries in total
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, offset, true);          // where the central directory starts

  const out = new Uint8Array(offset + centralSize + end.length);
  let at = 0;
  for (const part of [...locals, ...central, end]) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
