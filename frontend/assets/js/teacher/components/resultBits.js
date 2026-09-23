import { h } from "../../shared/dom.js";

/** How a session status reads on screen. */
export const SESSION_LABEL = {
  in_progress: "In progress",
  reopened: "Reopened",
  submitted: "Submitted",
  auto_submitted: "Auto-submitted",
  timed_out: "Timed out",
};
const SESSION_PILL = { in_progress: "plain", reopened: "warn", submitted: "plain", auto_submitted: "warn", timed_out: "warn" };

/** How a pass status reads on screen. */
export const PASS_LABEL = { passed: "Passed", failed: "Failed", not_final: "Not final" };
const PASS_PILL = { passed: "ok", failed: "bad", not_final: "warn" };

/** A score the way the mockups show it: whole numbers stay whole, halves keep one decimal. */
export function fmtScore(percentage) {
  if (percentage === null || percentage === undefined || percentage === "") return "—";
  const n = Number(percentage);
  if (!Number.isFinite(n)) return "—";
  const s = (Math.round(n * 10) / 10).toFixed(1);
  return s.endsWith(".0") ? s.slice(0, -2) : s;
}

export function fmtPoints(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "0";
  const s = (Math.round(n * 100) / 100).toFixed(2);
  return s.replace(/\.?0+$/, "");
}

/** "39m 10s", or just seconds when it is under a minute. */
export function fmtDuration(seconds) {
  if (seconds === null || seconds === undefined) return "—";
  const total = Math.max(0, Math.round(Number(seconds)));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}m ${String(s).padStart(2, "0")}s` : `${s}s`;
}

export function fmtWhen(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

export function statusPill(row) {
  if (row.has_result) {
    return h("span", { class: `pill ${PASS_PILL[row.pass_status] || "plain"}` }, PASS_LABEL[row.pass_status] || row.pass_status);
  }
  return h("span", { class: `pill ${SESSION_PILL[row.status] || "plain"}` }, SESSION_LABEL[row.status] || row.status);
}

/** The one-line summary above the results table (average, highest, lowest, passed, not final). */
export function summaryStrip(summary, passingGrade) {
  if (!summary) return h("div", { class: "strip" }, h("span", {}, h("b", {}, "—"), " no results yet"));
  const parts = [
    h("span", {}, h("b", {}, String(summary.with_result || 0)), summary.with_result === 1 ? " result" : " results"),
  ];
  if (summary.average !== null && summary.average !== undefined) parts.push(h("span", {}, h("b", {}, fmtScore(summary.average)), " average"));
  if (summary.highest !== null && summary.highest !== undefined) parts.push(h("span", {}, h("b", {}, fmtScore(summary.highest)), " highest"));
  if (summary.lowest !== null && summary.lowest !== undefined) parts.push(h("span", {}, h("b", {}, fmtScore(summary.lowest)), " lowest"));
  const decided = (summary.passed || 0) + (summary.failed || 0);
  if (decided > 0) {
    const pct = Math.round(((summary.passed || 0) / decided) * 100);
    parts.push(h("span", {}, h("b", {}, `${summary.passed} of ${decided}`), ` passed (${pct}%)`));
  }
  if (passingGrade !== undefined && passingGrade !== null && Number(passingGrade) > 0) {
    parts.push(h("span", { class: "hint" }, `Passing grade ${fmtScore(passingGrade)}`));
  }
  if (summary.not_final > 0) parts.push(h("span", { class: "pill warn" }, `${summary.not_final} not final`));
  if (summary.pending_essays > 0) parts.push(h("span", { class: "pill warn" }, `${summary.pending_essays} ${summary.pending_essays === 1 ? "essay" : "essays"} to grade`));
  if (summary.in_progress > 0) parts.push(h("span", { class: "pill plain" }, `${summary.in_progress} still taking it`));
  return h("div", { class: "strip" }, parts);
}

/**
 * Points for one answer. Answer-sheet bubbles up to ten whole points (the approved motif), a number
 * field for anything else (a weight like 2.5, or an essay worth 20).
 * Returns { el, get(), set(value) }.
 */
export function pointsPicker({ max, value = null, name }) {
  const whole = Number.isInteger(Number(max)) && Number(max) >= 1 && Number(max) <= 10;
  const wrap = h("div", { class: "pts", role: "radiogroup", "aria-label": "Points" });
  let input = null;
  let selected = value;

  if (whole) {
    const buttons = [];
    for (let p = 0; p <= Number(max); p++) {
      const b = h("button", { class: "bubble as-btn", type: "button", "aria-pressed": "false", "data-points": p }, String(p));
      b.addEventListener("click", () => {
        selected = p;
        for (const other of buttons) {
          other.classList.toggle("fill", other === b);
          other.setAttribute("aria-pressed", other === b ? "true" : "false");
        }
      });
      buttons.push(b);
      wrap.append(b);
    }
    wrap.append(h("span", { class: "hint" }, `out of ${max} ${Number(max) === 1 ? "point" : "points"}`));
    const set = (v) => {
      selected = v === null || v === undefined ? null : Number(v);
      for (const b of buttons) {
        const on = selected !== null && Number(b.dataset.points) === selected;
        b.classList.toggle("fill", on);
        b.setAttribute("aria-pressed", on ? "true" : "false");
      }
    };
    set(value);
    return { el: wrap, get: () => selected, set };
  }

  input = h("input", {
    class: "inp weight-input", type: "number", min: "0", max: String(max), step: "0.5",
    id: name ? `${name}-points` : undefined, "aria-label": "Points", value: value === null || value === undefined ? "" : String(value),
  });
  wrap.append(input, h("span", { class: "hint" }, `out of ${fmtPoints(max)} points`));
  return {
    el: wrap,
    get: () => (input.value === "" ? null : Number(input.value)),
    set: (v) => { input.value = v === null || v === undefined ? "" : String(v); },
  };
}

/** Minutes the teacher can hand out, for the add-time / reopen controls. */
export const MINUTE_CHOICES = [5, 10, 15, 30];

export function minutesSelect({ id, value = 10 }) {
  return h("select", { class: "chip-select", id },
    MINUTE_CHOICES.map((m) => h("option", { value: String(m), selected: m === value ? true : undefined }, `${m} minutes`)));
}
