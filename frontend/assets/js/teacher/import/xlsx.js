import { unzip } from "./zip.js";
const col = (ref) => { let n=0; for(const c of ref.replace(/\d/g, "")) n=n*26+c.charCodeAt(0)-64; return n-1; };
const decode = (value) => value.replace(/&(?:amp|lt|gt|quot|apos);|&#(\d+);|&#x([\da-f]+);/gi, (m, dec, hex) => dec ? String.fromCodePoint(Number(dec)) : hex ? String.fromCodePoint(parseInt(hex, 16)) : ({"&amp;":"&","&lt;":"<","&gt;":">","&quot;":"\"","&apos;":"'"}[m]));
const textContent = (value) => decode(value.replace(/<[^>]*>/g, ""));
export async function parseXlsx(buffer) {
  const files=await unzip(buffer), sheet=files.get("xl/worksheets/sheet1.xml"); if(!sheet) throw new Error("The first worksheet is missing.");
  const xml=(bytes)=>new TextDecoder().decode(bytes), shared=files.get("xl/sharedStrings.xml") ? [...xml(files.get("xl/sharedStrings.xml")).matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((m)=>textContent(m[1])) : [];
  const out=[]; for(const row of xml(sheet).matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)){ const cells=[]; for(const cell of row[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)){ const ref=/\br="([A-Z]+\d+)"/.exec(cell[1])?.[1] || "A1", type=/\bt="([^"]+)"/.exec(cell[1])?.[1], value=/<v\b[^>]*>([\s\S]*?)<\/v>/.exec(cell[2])?.[1] ?? /<t\b[^>]*>([\s\S]*?)<\/t>/.exec(cell[2])?.[1] ?? ""; cells[col(ref)]=type==="s" ? shared[Number(value)] ?? "" : textContent(value); } out.push(cells); } return out;
}
