import { h, mount } from "../../shared/dom.js";
import { icon } from "../../shared/icons.js";
import { toast } from "../../shared/ui.js";
import { results } from "../api/results.js";
import { SessionExpiredError } from "../../core/auth.js";
import {
  EVENT_LABEL, EVENT_SEVERITY_PILL, SESSION_LABEL,
  fmtDuration, fmtWhen, minutesSelect,
} from "../components/resultBits.js";

const errorText = (err) => err.message || "Something went wrong. Please try again.";
const ignorable = (err) => err instanceof SessionExpiredError;

/**
 * One student while an exam runs (mockup 12 side panel, full-page).
 * `#/monitor/:examId/session/:sessionId` — events, time left, add time.
 */
export function renderSessionTimeline(container, ctx, { examId, sessionId }) {
  const state = { requestId: 0, timer: null };
  const title = h("h1", {}, "Session");
  const subtitle = h("p", { class: "sub" }, "Loading…");
  const headActions = h("div", { class: "head-actions" });
  const strip = h("div", { class: "strip" });
  const actionCard = h("div", { class: "card sec" });
  const eventsCard = h("div", { class: "card sec" });
  const status = h("div", { class: "list-status", role: "status" });

  mount(
    container,
    h("div", { class: "head" },
      h("div", {},
        h("a", { class: "back", href: `#/monitor/${examId}` }, icon("left"), "Back to exam"),
        title, subtitle),
      headActions),
    strip,
    h("div", { class: "monitor-layout" },
      h("div", { class: "stack" }, actionCard, eventsCard)),
    status,
  );

  function renderStrip(report) {
    const { session } = report;
    const working = session.status === "in_progress" || session.status === "reopened";
    strip.replaceChildren(
      h("span", {}, h("b", {}, SESSION_LABEL[session.status] || session.status)),
      working && session.remaining_seconds != null
        ? h("span", {}, h("b", {}, fmtDuration(session.remaining_seconds)), " left")
        : null,
      h("span", {}, h("b", {}, String(session.tab_switch_count || 0)),
        session.tab_switch_count === 1 ? " page leave" : " page leaves"),
      session.last_heartbeat_at
        ? h("span", { class: "hint" }, `Last seen ${fmtWhen(session.last_heartbeat_at)}`)
        : null);
  }

  function renderActions(report) {
    const { session, actions } = report;
    const rows = [];

    if (actions.can_add_time) {
      const minutes = minutesSelect({ id: "monitor-add-time" });
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
        h("div", {},
          h("b", {}, "Add time"),
          h("p", { class: "hint" }, "For a phone that ran out of battery or a class that started late.")),
        h("div", { class: "row" }, minutes, btn)));
    }

    if (rows.length === 0) {
      actionCard.replaceChildren(
        h("h2", {}, "Actions"),
        h("p", { class: "hint" }, "Nothing to do here right now. Open the full report for grading, reopen, or a retake."));
      return;
    }
    actionCard.replaceChildren(h("h2", {}, "Actions"), ...rows);
  }

  function renderEvents(report) {
    const events = report.events || [];
    if (events.length === 0) {
      eventsCard.replaceChildren(h("h2", {}, "History"), h("p", { class: "hint" }, "No events recorded yet."));
      return;
    }
    const flags = [];
    if (events.some((e) => e.severity === "violation")) flags.push(h("span", { class: "pill bad" }, "Violation"));
    else if (events.some((e) => e.severity === "suspicious" || e.severity === "warning")) flags.push(h("span", { class: "pill warn" }, "Needs a look"));
    eventsCard.replaceChildren(
      h("div", { class: "row review-head" },
        h("h2", {}, "History"),
        h("span", { class: "hint" }, `${events.length} event${events.length === 1 ? "" : "s"}`),
        ...flags),
      h("div", { class: "events monitor-events" }, events.map((ev) => h("div", { class: "ev" },
        h("span", { class: `pill ${EVENT_SEVERITY_PILL[ev.severity] || "plain"}` },
          EVENT_LABEL[ev.event_type] || ev.event_type),
        h("span", { class: "hint" }, fmtWhen(ev.occurred_at))))));
  }

  async function load() {
    const id = ++state.requestId;
    try {
      const report = await results.sessionReport(sessionId);
      if (id !== state.requestId) return;
      const { session, exam } = report;
      title.textContent = session.student_name;
      subtitle.textContent = `${session.class_display || session.student_class} · ${exam.title}${session.attempt_no > 1 ? ` · attempt ${session.attempt_no}` : ""}`;
      headActions.replaceChildren(
        h("a", { class: "btn ghost", href: `#/results/${examId}/session/${sessionId}` }, icon("doc"), "Full report"));
      renderStrip(report);
      renderActions(report);
      renderEvents(report);
      status.replaceChildren();
    } catch (err) {
      if (id !== state.requestId || ignorable(err)) return;
      status.replaceChildren(h("p", { class: "sub" }, errorText(err)));
    }
  }

  load();
  state.timer = setInterval(() => { if (document.contains(container)) load(); }, 15_000);
  const observer = new MutationObserver(() => {
    if (!document.contains(container)) cleanup();
  });
  observer.observe(document.body, { childList: true, subtree: true });
  function cleanup() {
    if (state.timer) { clearInterval(state.timer); state.timer = null; }
    observer.disconnect();
  }
  return cleanup;
}
