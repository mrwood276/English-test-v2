import { assertEquals, assertThrows } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { parseCsv, detectDelimiter } from "../assets/js/teacher/import/csv.js";
import { spreadsheetDrafts } from "../assets/js/teacher/import/rows.js";
import { pastedDrafts } from "../assets/js/teacher/import/text.js";
import { parseXlsx } from "../assets/js/teacher/import/xlsx.js";

Deno.test("CSV handles BOM, quoted delimiters, escaped quotes, and new lines", () => {
  const rows = parseCsv('\uFEFFquestion;option_a;option_b;correct\n"One; two";"Dina ""D""";Budi;A\n"next\nline";Yes;No;A');
  assertEquals(detectDelimiter("a\tb\tc"), "\t");
  assertEquals(rows[1], ["One; two", 'Dina "D"', "Budi", "A"]);
  assertEquals(rows[2][0], "next\nline");
  assertThrows(() => parseCsv('"open'), Error, "unclosed");
});

Deno.test("spreadsheet rows use aliases, infer types, and return row-scoped problems", () => {
  const result = spreadsheetDrafts([
    ["Soal", "Pilihan A", "Pilihan B", "Kunci", "Kelas", "Poin"],
    ["Who found it?", "Dina", "Budi", "A", "XII A | XII B", "2"],
    ["The answer is", "", "", "past | simple past", "", "1"],
    ["Bad", "One", "Two", "C", "", "0"],
  ]);
  assertEquals(result[0].draft.type, "multiple_choice");
  assertEquals(result[0].draft.class_labels, ["XII A", "XII B"]);
  assertEquals(result[1].draft.type, "short_answer");
  assertEquals(result[1].draft.accepted_answers, ["past", "simple past"]);
  assertEquals(result[2].draft.row, 4);
  assertEquals(result[2].problems.some((p) => p.includes("correct")), true);
  assertEquals(result[2].problems.some((p) => p.includes("Points")), true);
});

Deno.test("pasted text recognizes options, answer markers, metadata and true false", () => {
  const rows = pastedDrafts(`[Reading text: Wallet]\nDina found a wallet.\n[/Reading text]\n\n1. Who found it?\nA. *Dina\nB. Budi\nTopic: Narrative\nClass: XII A, XII B\nReading text: Wallet\n\n2) Is it correct?\nAnswer: True\nDifficulty: easy`);
  assertEquals(rows[0].draft.options[0].is_correct, true);
  assertEquals(rows[0].draft.topic, "Narrative");
  assertEquals(rows[0].draft.passage, { title: "Wallet", body: "Dina found a wallet." });
  assertEquals(rows[1].draft.type, "true_false");
  assertEquals(rows[1].draft.options.length, 2);
});

function zipEntry(name, body) { const enc = new TextEncoder(), n=enc.encode(name), b=enc.encode(body), out=new Uint8Array(30+n.length+b.length); const dv=new DataView(out.buffer); dv.setUint32(0,0x04034b50,true); dv.setUint16(4,20,true); dv.setUint32(18,b.length,true); dv.setUint32(22,b.length,true); dv.setUint16(26,n.length,true); out.set(n,30); out.set(b,30+n.length); return out; }
function storedZip(name, body) { const local=zipEntry(name,body), n=new TextEncoder().encode(name), central=new Uint8Array(46+n.length), d=new DataView(central.buffer); d.setUint32(0,0x02014b50,true); d.setUint16(4,20,true); d.setUint16(6,20,true); d.setUint32(20,new TextEncoder().encode(body).length,true); d.setUint32(24,new TextEncoder().encode(body).length,true); d.setUint16(28,n.length,true); central.set(n,46); const end=new Uint8Array(22), e=new DataView(end.buffer); e.setUint32(0,0x06054b50,true); e.setUint16(8,1,true); e.setUint16(10,1,true); e.setUint32(12,central.length,true); e.setUint32(16,local.length,true); const all=new Uint8Array(local.length+central.length+end.length); all.set(local); all.set(central,local.length); all.set(end,local.length+central.length); return all.buffer; }
Deno.test("XLSX reads the first worksheet", async () => {
  const xml='<?xml version="1.0"?><worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>question</t></is></c><c r="B1" t="inlineStr"><is><t>correct</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>Yes?</t></is></c><c r="B2" t="inlineStr"><is><t>True</t></is></c></row></sheetData></worksheet>';
  assertEquals(await parseXlsx(storedZip("xl/worksheets/sheet1.xml", xml)), [["question", "correct"], ["Yes?", "True"]]);
});
