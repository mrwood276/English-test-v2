/** Reads unencrypted ZIP entries needed by XLSX. Uses the browser's built-in deflate support. */
const u16 = (v, o) => v[o] | v[o + 1] << 8;
const u32 = (v, o) => (u16(v,o) | u16(v,o + 2) << 16) >>> 0;
const text = (v) => new TextDecoder().decode(v);
export async function unzip(buffer) {
  const v = new Uint8Array(buffer); let end = -1;
  for (let i = v.length - 22; i >= Math.max(0, v.length - 65558); i--) if (u32(v,i) === 0x06054b50) { end = i; break; }
  if (end < 0) throw new Error("This is not a ZIP file.");
  const entries = new Map(); let p = u32(v,end + 16);
  for (let i = 0; i < u16(v,end + 10); i++) { if (u32(v,p) !== 0x02014b50) throw new Error("The ZIP directory is invalid."); const method=u16(v,p+10), size=u32(v,p+24), name=text(v.slice(p+46,p+46+u16(v,p+28))), off=u32(v,p+42); if (u32(v,off)!==0x04034b50) throw new Error("The ZIP entry is invalid."); const data=v.slice(off+30+u16(v,off+26)+u16(v,off+28),off+30+u16(v,off+26)+u16(v,off+28)+u32(v,off+18)); let raw; if(method===0) raw=data; else if(method===8) raw=new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer()); else throw new Error("This XLSX uses an unsupported ZIP compression method."); entries.set(name,raw.slice(0,size)); p += 46+u16(v,p+28)+u16(v,p+30)+u16(v,p+32); }
  return entries;
}
