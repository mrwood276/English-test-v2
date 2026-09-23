import { h, mount } from "../../shared/dom.js";
import { icon } from "../../shared/icons.js";
import { results } from "../api/results.js";
import { SessionExpiredError } from "../../core/auth.js";

const errorText = (err) => err.message || "Something went wrong. Please try again.";
const ignorable = (err) => err instanceof SessionExpiredError;

/**
 * One-session timeline (#/monitor/:examId/session/:sessionId).
 * Shows the student's attempt with progress, time left, page leaves, and the event history.
 * Mockup frame 12: monitor for one attempt.
 */
export function renderSessionTimeline(container, ctx, { examId, sessionId }) {
  const state = { report: null, requestId: 0, autoRefresh: null };

  const back = h("a", { class: "back", href: `#/monitor/${examId}` }, icon("left"), "Back to exam");
  const title = h("h1", {}, "Session");
  const subtitle = h("p", { class: "sub" }, "Loading…");
  const strip = h("div", { class: "strip" });
  const tbody = h("tbody");
  const status = h("div", { class: "list-status", role: "status" });

  mount(
    container,
    h("div", { class: "head" },
      h("div", {},
        back,
        title, subtitle),
      h("div", { class: "head-actions" },
        h("a", { class: "btn ghost", href: `#/results/${examId}/session/${sessionId}` }, icon("doc"), "Full report"))),
    strip,
    h("div", { class: "card list-card" },
      h("div", { class: "table-wrap" },
        h("table", { class: "qtable" },
          h("thead", {}, h("tr", {},
            h("th", {}, "Question"),
            h("th", {}, "Your answer"),
            h("th", {}, "Correct"),
            h("th", {}, "Points"))),
          tbody)),
      status),
    h("div", { class: "card" },
      h("div", { class: "sec" },
        h("h5", {}, "Event history"),
        status)),
  );

  function eventRow(event) {
    const severityClass = event.severity === "violation" ? "b"
      : event.severity === "suspicious" ? "w" : "";
    const label = event.event_type
      .replace(/_/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase());
    return h("div", { class: `tl ${severityClass}` },
      h("div", {},
        h("b", {}, label),
        h("small", {}, new Date(event.occurred_at).toLocaleTimeString())),
      h("small", {}, event.meta && Object.keys(event.meta).length ? JSON.stringify(event.meta) : ""));
  }

  function answerRow(q) {
    const pct = q.max_points > 0 ? Math.round(q.points / q.max_points * 100) : 0;
    const meter = h("i", { style: `width:${Math.min(100, Math.max(0, pct))}%` });
    return h("tr", { "data-question": q.question_id },
      h("td", {},
        h("b", {}, q.position + ". " + q.body),
        h("small", {}, q.type)),
      h("td", {},
        q.answer
          ? h("span", {}, q.answer.text || q.answer)
          : h("span", { class: "hint" }, q.is_blank ? "(not answered)" : "—")),
      h("td", {},
        q.is_correct != null
          ? q.is_correct
            ? h("span", { class: "pill ok" }, "Correct")
            : h("span", { class: "pill bad" }, "Wrong")
          : h("span", { class: "hint" }, q.is_essay ? "(awaiting grading)" : "—")),
      h("td", {},
        h("span", { class: "prog" },
          meter,
          ` ${q.points}/${q.max_points}`));
  }

  async function load() {
    const id = ++state.requestId;
    status.replaceChildren(h("p", { class: "sub" }, "Loading…"));
    try {
      const report = await results.sessionReport(sessionId);
      if (id !== state.requestId) return;
      state.report = report;
      const { session, result, review, events, actions } = report;

      title.textContent = session.exam_title;
      subtitle.textContent = `${session.student_name} · ${session.student_class}`;

      // Strip: session info
      strip.replaceChildren(
        h("b", {}, session.student_name),
        h("span", {}, `· ${session.student_class}`),
        h("span", {}, `· Attempt ${session.attempt_no}`),
        h("span", {},
          session.status === "in_progress" || session.status === "reopened"
            ? h("span", { class: "timer" }, `<svg class="i"><use href="#i-clock"/></svg>${Math.round(session.remaining_seconds / 60)}:${String(Math.round(session.remaining_seconds % 60)).padStart(2, "0")}`)
            : h("span", { class: "pill" + (session.status === "submitted" ? " ok" : " plain") }, session.status.replace("_", " ")),
      );

      // Answer table
      tbody.replaceChildren(...(review || []).map(answerRow));
      if (!review || review.length === 0) {
        tbody.replaceChildren(h("tr", {},
          h("td", { colspan: 4 }, h("p", { class: "sub" }, "No answers yet.")));
      }

      // Event history
      const eventStatus = status;
      const eventsList = events || [];
      if (eventsList.length === 0) {
        eventStatus.replaceChildren(h("p", { class: "sub" }, "No events recorded yet."));
      } else {
        eventStatus.replaceChildren(
          h("div", { class: "live" },
            h("span", {}, `${eventsList.length} event${eventsList.length === 1 ? "" : "s"}`),
            h("span", {},
              eventsList.some((e) => e.severity === "violation")
                ? h("span", { class: "pill bad" }, "Violation")
                : eventsList.some((e) => e.severity === "suspicious")
                  ? h("span", { class: "pill warn" }, "Suspicious")
                  : h("span", { class: "pill plain" }, "Info")),
          ),
          ...eventsList.slice().reverse().map(eventRow),
        );
      }
    } catch (err) {
      if (id !== state.requestId || ignorable(err)) return;
      status.replaceChildren(h("p", { class: "sub" }, errorText(err)));
    }
  }

  function startAutoRefresh() {
    if (state.autoRefresh) return;
    state.autoRefresh = setInterval(() => { if (document.contains(container)) load(); }, 15_000);
  }

  function stopAutoRefresh() {
    if (state.autoRefresh) {
      clearInterval(state.autoRefresh);
      state.autoRefresh = null;
    }
  }

  load();
  startAutoRefresh();

  const observer = new MutationObserver(() => {
    if (!document.contains(container)) stopAutoRefresh();
  });
  observer.observe(document.body, { childList: true, subtree: true });

  return () => {
    stopAutoRefresh();
    observer.disconnect();
  };
}
