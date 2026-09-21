import { h, mount } from "../../shared/dom.js";
import { toast } from "../../shared/ui.js";
import { plainText } from "../../shared/rich.js";
import { setLeaveGuard, clearLeaveGuard } from "../guard.js";
import { questionBank } from "../api/questionBank.js";
import { parseCsv } from "../import/csv.js";
import { spreadsheetDrafts } from "../import/rows.js";
import { pastedDrafts } from "../import/text.js";
import { parseXlsx } from "../import/xlsx.js";

export function renderQuestionImport(container) {
  const file = h("input", { class: "input", type: "file", accept: ".csv,.xlsx", "aria-label": "Import spreadsheet" });
  const text = h("textarea", { class: "input", rows: 12, placeholder: "Paste numbered questions from Word or text here.", "aria-label": "Paste questions" });
  const review = h("div", { class: "card list-card", hidden: true });
  const status = h("p", { class: "sub" }, "Choose a CSV/XLSX file or paste questions. Nothing is saved until you confirm the review.");
  const read = h("button", { class: "btn", type: "button" }, "Review import");
  const back = h("a", { class: "back", href: "#/questions" }, "← Back to question bank");
  let rows = [];
  mount(container, h("div", { class: "head" }, h("div", {}, h("h1", {}, "Import questions"), status), back), h("div", { class: "editor card" }, h("label", {}, "Spreadsheet (.csv or .xlsx)", file), h("p", { class: "hint" }, "First row is a header. The proposed format supports English and Indonesian headers."), h("label", {}, "Or paste text", text), h("p", { class: "hint" }, "Number questions with 1. or 1), options A.–F., and Answer: B. Proposed formats can be changed after your review."), read), review);
  setLeaveGuard(async () => !rows.length || confirm("Leave this import review? Your parsed questions will be lost."));
  read.addEventListener("click", async () => {
    try {
      if (file.files[0]) { const f=file.files[0]; rows=f.name.toLowerCase().endsWith(".xlsx") ? spreadsheetDrafts(await parseXlsx(await f.arrayBuffer())) : spreadsheetDrafts(parseCsv(await f.text())); }
      else rows = pastedDrafts(text.value);
      if (!rows.length) throw new Error("Add at least one question before reviewing.");
      const valid=rows.filter((r)=>!r.problems.length); const matches=valid.length ? await questionBank.importCheck(valid.map((r,i)=>({i,body:r.draft.body,options:r.draft.options.map((o)=>o.body)}))) : [];
      for(const result of matches) if(valid[result.i]) valid[result.i].matches=result.matches;
      render();
    } catch (err) { toast(err.message || "Could not read this import.", "error"); }
  });
  function render() {
    review.hidden=false; const eligible=rows.filter((r)=>!r.problems.length && !(r.matches||[]).some((m)=>m.exact));
    const tbody=h("tbody", {}, rows.map((r)=>h("tr", {}, h("td", {}, String(r.draft.row)), h("td", {}, plainText(r.draft.body,100)), h("td", {}, r.draft.type), h("td", {}, r.problems.length ? r.problems.join(" ") : (r.matches||[]).some((m)=>m.exact) ? "Duplicate in bank" : (r.matches||[]).length ? "Similar question" : "Ready"))));
    const submit=h("button", { class:"btn", type:"button", disabled:!eligible.length }, `Import ${eligible.length} question${eligible.length===1?"":"s"}`);
    submit.addEventListener("click", async()=>{ try { const res=await questionBank.import(eligible.map((r)=>r.draft)); clearLeaveGuard(); toast(`${res.created} questions imported.`); location.hash="#/questions"; } catch(err) { toast(err.message||"Could not import questions.","error"); } });
    review.replaceChildren(h("h2", {}, "Review import"), h("table", {class:"qtable"}, h("thead",{},h("tr",{},h("th",{},"Row"),h("th",{},"Question"),h("th",{},"Type"),h("th",{},"Status"))),tbody), h("p", {class:"hint"}, "Rows with errors and exact duplicates are not imported."), submit);
  }
}
