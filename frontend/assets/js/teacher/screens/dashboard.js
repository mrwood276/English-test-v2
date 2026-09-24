import { h, mount } from "../../shared/dom.js";
import { icon } from "../../shared/icons.js";
import { startRefresh, toast, confirmDialog } from "../../shared/ui.js";
import { exams } from "../api/exams.js";
import { results } from "../api/results.js";
import { liveStatusPill } from "../components/resultBits.js";
import { SessionExpiredError } from "../../core/auth.js";

const errorText = (err) => err.message || "Something went wrong. Please try again.";
const ignorable = (err) => err instanceof SessionExpiredError;
const isWorking = (r) => r.status === "in_progress" || r.status === "reopened";
const timeOf = (iso) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/**
 * The teacher's dashboard (mockup 5): the exam that is running now with its code written
 * large enough to put on the board, the few things that need a teacher, and the latest
 * results. Everything is read from the payloads the Exams/Results screens already use,
 * so the dashboard can never disagree with them.
 */
export function renderDashboard(container, { onSignOut }) {
  const state = { requestId: 0, timer: null };

  const signOut = h("button", { class: "btn ghost", type: "button" }, "Sign out");
  signOut.addEventListener("click", async () => {
    signOut.disabled = true;
    await onSignOut();
  });

  const status = h("div", { class: "list-status", role: "status" });
  const openArea = h("div", { class: "dash-open" });
  const attentionBody = h("div", {});
  const recentBody = h("div", {});

  mount(
    container,
    h("div", { class: "head" },
      h("div", {},
        h("h1", {}, "Dashboard"),
        h("p", { class: "sub" }, new Date().toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" }))),
      h("div", { class: "head-actions" },
        h("a", { class: "btn", href: "#/exams/new" }, icon("plus"), "New exam"),
        signOut)),
    status,
    h("div", { class: "dash-layout" },
      openArea,
      h("div", { class: "grid2" },
        h("section", { class: "card dash-list", "aria-label": "Needs your attention" },
          h("h2", {}, "Needs your attention"),
          attentionBody),
        h("section", { class: "card dash-list", "aria-label": "Recent exams" },
          h("h2", {}, "Recent exams"),
          recentBody))),
  );

  // ---------- the "Open now" card (mockup 5): big code, the actions, a live preview ----------
  function openCard(exam, overview) {
    const rows = overview?.rows ?? [];
    const working = rows.filter(isWorking);
    const done = rows.filter((r) => !isWorking(r));
    const classes = [...new Set(working.map((r) => r.class_display || r.student_class).filter(Boolean))];

    const copyBtn = h("button", { class: "btn small ghost", type: "button" }, icon("copy"), "Copy code");
    copyBtn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(exam.access_code);
        toast("Test code copied.");
      } catch {
        toast("Could not copy automatically. Select the code and copy it by hand.", "bad");
      }
    });

    const changeBtn = h("button", { class: "btn small ghost", type: "button" }, "Change code");
    changeBtn.addEventListener("click", async () => {
      const ok = await confirmDialog({
        title: "Change the test code?",
        message: "Students who already started keep their sessions. New students need the new code.",
        confirmLabel: "Change code",
      });
      if (!ok) return;
      changeBtn.disabled = true;
      try {
        const code = await exams.regenerateCode(exam.id);
        toast(`New test code: ${code}`);
        load();
      } catch (err) { if (!ignorable(err)) toast(errorText(err), "bad"); }
      finally { changeBtn.disabled = false; }
    });

    const closeBtn = h("button", { class: "btn small danger", type: "button" }, "Close exam");
    closeBtn.addEventListener("click", async () => {
      const ok = await confirmDialog({
        title: "Close this exam?",
        message: `Students can no longer join \u201C${exam.title}\u201D. Sessions in progress keep their time.`,
        confirmLabel: "Close exam",
      });
      if (!ok) return;
      closeBtn.disabled = true;
      try {
        await exams.setStatus(exam.id, "closed");
        toast("Exam closed.");
        load();
      } catch (err) { if (!ignorable(err)) toast(errorText(err), "bad"); }
      finally { closeBtn.disabled = false; }
    });

    const meta = [
      `${exam.question_count} ${exam.question_count === 1 ? "question" : "questions"}`,
      `${exam.duration_minutes} minutes`,
      exam.availability_mode === "scheduled" && exam.ends_at ? `closes ${timeOf(exam.ends_at)}` : "open until you close it",
    ].join(" · ");

    function liveRow(r) {
      const sub = isWorking(r)
        ? `${r.answered_count ?? 0} of ${r.question_count ?? "—"} answered`
        : r.submitted_at ? `Submitted ${timeOf(r.submitted_at)}` : "Done";
      return h("div", { class: "live" },
        h("span", {}, r.student_name, h("small", {}, sub)),
        liveStatusPill(r));
    }

    const preview = [...working.sort((a, b) => (a.student_name || "").localeCompare(b.student_name || "")),
      ...done.sort((a, b) => (a.student_name || "").localeCompare(b.student_name || ""))].slice(0, 5);
    const more = rows.length - preview.length;

    return h("section", { class: "card now", "aria-label": "Open now" },
      h("div", { class: "now-l" },
        h("span", { class: "pill ok" }, "Open now"),
        h("div", { class: "now-title" }, exam.title),
        h("div", { class: "now-meta" }, meta),
        h("div", { class: "bigcode" }, exam.access_code),
        h("div", { class: "row gap now-actions" }, copyBtn, changeBtn, closeBtn)),
      h("div", { class: "now-r" },
        h("div", { class: "now-count" },
          h("b", {}, `${working.length} of ${rows.length} working`),
          classes.slice(0, 2).map((c) => h("span", { class: "pill plain" }, c)),
          classes.length > 2 ? h("span", { class: "pill plain" }, `+${classes.length - 2}`) : null),
        preview.length > 0
          ? preview.map(liveRow)
          : h("p", { class: "hint" }, "Nobody has joined yet. Share the code."),
        more > 0 ? h("p", { class: "hint" }, `+${more} more in the monitor.`) : null,
        h("a", { class: "link-btn", href: `#/monitor/${exam.id}` }, "Watch everyone")));
  }

  function noOpenCard() {
    return h("section", { class: "card now-empty", "aria-label": "No exam open" },
      h("h2", {}, "No exam is open right now"),
      h("p", { class: "hint" }, "Open one from Exams, or create a new one for today\u2019s class."),
      h("div", { style: "margin-top:12px" },
        h("a", { class: "btn small", href: "#/exams/new" }, icon("plus"), "New exam"),
        " ",
        h("a", { class: "btn small ghost", href: "#/exams" }, "All exams")));
  }

  // ---------- "Needs your attention": only what a teacher must act on ----------
  function attentionRows(activity, overviews) {
    const items = [];
    for (const exam of activity) {
      if (exam.pending_essays > 0) {
        items.push(h("div", { class: "dash-item" },
          h("span", {},
            `${exam.pending_essays} ${exam.pending_essays === 1 ? "essay" : "essays"} to grade`,
            h("small", {}, exam.title)),
          h("a", { class: "btn small", href: `#/grading/${exam.exam_id}` }, "Grade")));
      }
      const ov = overviews.get(exam.exam_id);
      const exits = ov ? ov.rows.filter((r) => isWorking(r) &&
        (r.tab_switch_count || 0) >= (r.tab_switch_flag_limit ?? 3)).length : 0;
      if (exits > 0) {
        items.push(h("div", { class: "dash-item" },
          h("span", {},
            `${exits} ${exits === 1 ? "session has" : "sessions have"} many page exits`,
            h("small", {}, `${exam.title}, review before grading`)),
          h("a", { class: "btn small ghost", href: `#/monitor/${exam.exam_id}` }, "Review")));
      }
    }
    if (items.length === 0) {
      return h("p", { class: "hint" }, "Nothing needs you right now. New essays and suspicious sessions appear here.");
    }
    return items;
  }

  // ---------- "Recent exams": the latest results with their pass rate ----------
  function recentRows(activity) {
    const recent = activity
      .filter((a) => !a.is_template && a.finished > 0)
      .sort((a, b) => String(b.last_submitted_at ?? "").localeCompare(String(a.last_submitted_at ?? "")))
      .slice(0, 3);
    if (recent.length === 0) {
      return h("p", { class: "hint" }, "No exam has been taken yet. Finished tests appear here.");
    }
    return recent.map((exam) => {
      const decided = (exam.passed || 0) + (exam.failed || 0);
      const pct = decided > 0 ? Math.round(((exam.passed || 0) / decided) * 100) : null;
      return h("div", { class: "dash-item" },
        h("span", {},
          h("a", { class: "row-title", href: `#/results/${exam.exam_id}` }, exam.title),
          h("small", {},
            `Average ${exam.average ?? "—"} · ${exam.finished} ${exam.finished === 1 ? "student" : "students"}`)),
        h("span", { class: "dash-pass" },
          pct !== null
            ? [h("span", { class: "meter", "aria-label": `${pct}% passed` }, h("i", { style: `width:${pct}%` })), ` ${pct}% passed`]
            : h("span", { class: "pill warn" }, "Waiting for grading")));
    });
  }

  async function load() {
    const id = ++state.requestId;
    status.replaceChildren(h("p", { class: "sub" }, "Loading…"));
    try {
      const [openExams, activity] = await Promise.all([
        exams.list({ status: "open", sort: "newest" }),
        results.activity(),
      ]);
      if (id !== state.requestId) return;
      const open = openExams.filter((e) => !e.is_template);

      // One overview per exam the dashboard watches live: every open exam (its preview)
      // plus any exam where someone is still working even though it closed.
      const watchIds = new Set(open.map((e) => e.id));
      for (const exam of activity) {
        if (exam.in_progress > 0) watchIds.add(exam.exam_id);
      }
      const overviews = new Map();
      const loaded = await Promise.all([...watchIds].map((examId) =>
        results.overview(examId).catch(() => null)));
      if (id !== state.requestId) return;
      for (const ov of loaded) if (ov) overviews.set(ov.exam.id, ov);

      status.replaceChildren();
      openArea.replaceChildren(
        ...open.map((exam) => openCard(exam, overviews.get(exam.id))),
        open.length === 0 ? noOpenCard() : null);
      attentionBody.replaceChildren(...attentionRows(activity, overviews));
      recentBody.replaceChildren(...recentRows(activity));
    } catch (err) {
      if (id !== state.requestId || ignorable(err)) return;
      status.replaceChildren(h("p", { class: "sub" }, errorText(err)));
    }
  }

  return startRefresh(container, state, load, 30_000);
}
