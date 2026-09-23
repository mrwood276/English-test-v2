import { h, mount } from "../../shared/dom.js";
import { icon } from "../../shared/icons.js";
import { toast, confirmDialog } from "../../shared/ui.js";
import { results } from "../api/results.js";
import { SessionExpiredError } from "../../core/auth.js";
import { reviewItem } from "../components/reviewItem.js";
import {
  EVENT_LABEL, EVENT_SEVERITY_PILL, PASS_LABEL, SESSION_LABEL,
  fmtDuration, fmtPoints, fmtScore, fmtWhen, minutesSelect,
} from "../components/resultBits.js";

const errorText = (err) => err.message || "Something went wrong. Please try again.";
const ignorable = (err) => err instanceof SessionExpiredError;

/**
 * One finished attempt: the result, every answer with its grade (essays and corrections can be changed
 * here), the event history, and the actions a teacher may take — more time, reopen, allow a retake (BR-11, BR-02).
 */
export function renderSessionReport(container, ctx, { examId, sessionId }) {
  const state = { report: null, requestId: 0 };

  const title = h("h1", {}, "Attempt");
  const subtitle = h("p", { class: "sub" }, "Loading…");
  const headActions = h("div", { class: "head-actions" });
  const resultCard = h("div", { class: "card sec" });
  const actionCard = h("div", { class: "card sec" });
  const reviewWrap = h("div", { class: "review-list" });
  const eventsCard = h("div", { class: "card sec" });
  const status = h("div", { class: "list-status", role: "status" });

  mount(
    container,
    h("div", { class: "head" },
      h("div", {},
        h("a", { class: "back", href: `#/results/${examId}` }, icon("left"), "Results"),
        title, subtitle),
      headActions),
    h("div", { class: "report-layout" },
      h("div", { class: "stack" }, resultCard, actionCard, eventsCard),
      reviewWrap),
    status,
  );

  function renderResult(report) {
    const { result, session, exam } = report;
    if (!result) {
      resultCard.replaceChildren(
        h("h2", {}, "No result yet"),
        h("p", { class: "sub" }, "This attempt has not been sent in, so nothing is graded."));
      return;
    }
    const pending = result.status === "pending_review";
    resultCard.replaceChildren(
      h("h2", {}, "Result"),
      h("div", { class: "score-line" },
        h("span", { class: "score-big" }, fmtScore(result.percentage)),
        h("span", { class: `pill ${result.pass_status === "passed" ? "ok" : result.pass_status === "failed" ? "bad" : "warn"}` },
          PASS_LABEL[result.pass_status] || result.pass_status),
        pending ? h("span", { class: "hint" }, "an essay is still waiting") : null),
      h("div", { class: "kv-list" },
        h("div", {}, h("span", { class: "hint" }, "Points "), `${fmtPoints(result.total_points)} of ${fmtPoints(result.max_points)}`),
        h("div", {}, h("span", { class: "hint" }, "Right / wrong "), `${result.correct_count} / ${result.wrong_count}`),
        h("div", {}, h("span", { class: "hint" }, "Time used "), fmtDuration(result.time_used_seconds)),
        h("div", {}, h("span", { class: "hint" }, "Page leaves "), String(session.tab_switch_count)),
        h("div", {}, h("span", { class: "hint" }, "Passing grade "), fmtScore(exam.passing_grade))),
      h("p", { class: "hint" }, `The student sees ${exam.result_visibility === "none" ? "nothing" : exam.result_visibility === "score" ? "the score" : "the score and the review"}.`),
    );
  }

  function renderActions(report) {
    const { session, actions, retake } = report;
    const rows = [];

    if (actions.can_add_time) {
      const minutes = minutesSelect({ id: "add-time" });
      const btn = h("button", { class: "btn small", type: "button", "data-add-time": "" }, "Add time");
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        try {
          const res = await results.addTime(session.id, Number(minutes.value));
          toast(`Time added. ${fmtDuration(res.remaining_seconds)} left.`);
          await load();
        } catch (err) { if (!ignorable(err)) toast(errorText(err), "bad"); }
        finally { btn.disabled = false; }
      });
      rows.push(h("div", { class: "action-row" },
        h("div", {}, h("b", {}, "Add time"), h("p", { class: "hint" }, "For a phone that ran out of battery or a class that started late.")),
        h("div", { class: "row" }, minutes, btn)));
    }

    if (actions.can_reopen) {
      const minutes = minutesSelect({ id: "reopen" });
      const btn = h("button", { class: "btn small", type: "button", "data-reopen": "" }, "Reopen");
      btn.addEventListener("click", async () => {
        const ok = await confirmDialog({
          title: "Reopen this attempt?",
          message: `${session.student_name} can carry on where they stopped. What they send in again replaces this result.`,
          confirmLabel: "Reopen",
        });
        if (!ok) return;
        btn.disabled = true;
        try {
          await results.reopen(session.id, Number(minutes.value));
          toast("Reopened. The student can continue on the same phone.");
          await load();
        } catch (err) { if (!ignorable(err)) toast(errorText(err), "bad"); }
        finally { btn.disabled = false; }
      });
      rows.push(h("div", { class: "action-row" },
        h("div", {}, h("b", {}, "Reopen the attempt"), h("p", { class: "hint" }, "The student continues on the same phone; the automatic submit is undone.")),
        h("div", { class: "row" }, minutes, btn)));
    }

    if (actions.can_grant_retake || retake) {
      const btn = h("button", { class: "btn small ghost", type: "button", "data-retake": "" },
        actions.can_grant_retake ? "Allow one retake" : "Take the retake back");
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        try {
          if (actions.can_grant_retake) {
            await results.grantRetake(session.id);
            toast("Retake allowed. The same name and class can join again once.");
          } else {
            await results.revokeRetake(session.id);
            toast("Retake taken back.");
          }
          await load();
        } catch (err) { if (!ignorable(err)) toast(errorText(err), "bad"); }
        finally { btn.disabled = false; }
      });
      rows.push(h("div", { class: "action-row" },
        h("div", {},
          h("b", {}, "Another attempt"),
          h("p", { class: "hint" }, retake ? (retake.used ? "The student already used their retake." : "A retake is waiting to be used.") : "One more attempt for the same name and class (BR-02).")),
        h("div", { class: "row" }, btn)));
    }

    if (rows.length === 0) {
      actionCard.replaceChildren(h("h2", {}, "Actions"), h("p", { class: "hint" }, "Nothing can be done with this attempt right now."));
      return;
    }
    actionCard.replaceChildren(h("h2", {}, "Actions"), ...rows);
  }

  function renderReview(report) {
    const canGrade = report.actions.can_grade;
    reviewWrap.replaceChildren(
      h("div", { class: "row review-head" },
        h("h2", {}, "Answers"),
        h("span", { class: "hint" }, canGrade
          ? "Change any grade by hand; essays wait for you."
          : "The student is still taking this test.")),
      ...report.review.map((item) => reviewItem({
        item,
        canGrade,
        onSave: async ({ questionId, points, feedback }) => {
          const res = await results.grade({ sessionId, questionId, points, feedback });
          toast(res.final ? "Saved. The result is final now." : "Saved.");
          window.dispatchEvent(new CustomEvent("staff:results-changed"));
          await load();
        },
      })),
    );
  }

  function renderEvents(report) {
    const counts = report.event_counts || {};
    const summary = Object.entries(counts)
      .filter(([type]) => type !== "join")
      .map(([type, n]) => h("span", { class: "pill plain" }, `${EVENT_LABEL[type] || type}: ${n}`));
    eventsCard.replaceChildren(
      h("h2", {}, "History"),
      summary.length > 0 ? h("div", { class: "chips" }, summary) : h("p", { class: "hint" }, "Nothing unusual happened."),
      h("div", { class: "events" }, report.events.slice(0, 40).map((ev) => h("div", { class: "ev" },
        h("span", { class: `pill ${EVENT_SEVERITY_PILL[ev.severity] || "plain"}` }, EVENT_LABEL[ev.event_type] || ev.event_type),
        h("span", { class: "hint" }, fmtWhen(ev.occurred_at))))),
    );
  }

  async function load() {
    const id = ++state.requestId;
    try {
      const report = await results.report(sessionId);
      if (id !== state.requestId) return;
      state.report = report;
      const { session, exam } = report;
      title.textContent = session.student_name;
      subtitle.textContent = `${session.class_display || session.student_class} · ${exam.title}${session.attempt_no > 1 ? ` · attempt ${session.attempt_no}` : ""}`;
      headActions.replaceChildren(
        h("span", { class: `pill ${session.status === "in_progress" || session.status === "reopened" ? "warn" : "plain"}` }, SESSION_LABEL[session.status] || session.status),
        h("a", { class: "btn small ghost", href: `#/results/${examId}` }, "Back to results"));
      renderResult(report);
      renderActions(report);
      renderReview(report);
      renderEvents(report);
      status.replaceChildren();
    } catch (err) {
      if (id !== state.requestId || ignorable(err)) return;
      status.replaceChildren(h("p", { class: "sub" }, errorText(err)));
    }
  }

  load();
}
