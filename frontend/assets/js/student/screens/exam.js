import { h, mount } from "../../shared/dom.js";
import { icon } from "../../shared/icons.js";
import { confirmDialog } from "../../shared/ui.js";
import { questionBlock } from "../components/question.js";
import { isExpiredSession, NetworkError, sessionApi } from "../api.js";
import * as store from "../store.js";

/** Autosave keeps answers on the server without a save button; the timer follows the server clock. */
const SAVE_DEBOUNCE_MS = 1200;
const RETRY_MS = 5000;
const HEARTBEAT_MS = 30_000;
const MEDIA_REFRESH_MS = 45 * 60 * 1000; // signed links last an hour
const BLUR_THROTTLE_MS = 10_000;

const two = (n) => String(n).padStart(2, "0");
function clockText(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const rest = `${two(Math.floor((s % 3600) / 60))}:${two(s % 60)}`;
  return s >= 3600 ? `${Math.floor(s / 3600)}:${rest}` : rest;
}

/**
 * The exam screen (mockups 2, 3, 7, 8). One question at a time, an answer sheet for jumping around,
 * autosave with an offline queue (BR-12), a server-backed timer (BR-20), and the page-leave warning.
 *
 * @param ctx { onSubmitted(result, reason), onSessionLost(message) }
 */
export function renderExam(root, ctx) {
  const state = store.state;
  const exam = state.session.exam;
  const total = state.questions.length;

  let index = 0;
  let block = null;
  let saving = false;
  let submitting = false;
  let submitted = false;
  let saveTimer = null;
  let retryTimer = null;
  let tickTimer = null;
  let beatTimer = null;
  let lastBlurLogged = 0;
  let sheet = null;
  let dim = null;

  const requestId = () => state.questions[index]?.question_id;

  // ---------- chrome ----------
  const counter = h("span", { class: "q" });
  const timerEl = h("span", { class: "timer" });
  const progress = h("i", { style: "width:0%" });
  const saveLine = h("div", { class: "saved" });
  const offlineBar = h("div", { class: "offbar", hidden: true },
    icon("offline"),
    h("span", {}, "No connection. Keep going. Your answers are kept on this phone and will be sent when you are back online."));
  const body = h("div", { class: "qbody" });
  const markLabel = h("span", {}, "Mark");
  const markBtn = h("button", { class: "btn mark small", type: "button", "aria-pressed": "false" }, icon("flag"), markLabel);
  const sheetBtn = h("button", { class: "icobtn", type: "button", "aria-label": "Answer sheet" }, icon("grid"));
  const prevBtn = h("button", { class: "icobtn", type: "button", "aria-label": "Previous question" }, icon("left"));
  const nextBtn = h("button", { class: "btn small", type: "button", style: "flex:1" }, "Next", icon("right"));

  const setSave = (kind, text) => {
    saveLine.classList.toggle("warn", kind === "warn");
    saveLine.replaceChildren(icon(kind === "warn" ? "offline" : "cloud"), h("span", {}, text));
  };
  const showOffline = () => { offlineBar.hidden = false; };
  const hideOffline = () => { offlineBar.hidden = true; };

  // ---------- saving ----------
  const idsOf = (answers) => answers.map((a) => a.question_id);

  function scheduleRetry() {
    if (retryTimer) return;
    retryTimer = setTimeout(() => { retryTimer = null; flush(); }, RETRY_MS);
  }

  function queueSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, SAVE_DEBOUNCE_MS);
  }

  async function flush() {
    if (submitted || saving) return;
    clearTimeout(saveTimer);
    const pending = store.pendingAnswers();
    if (pending.length === 0) { setSave("ok", "All answers saved"); return; }
    if (navigator.onLine === false) {
      showOffline();
      setSave("warn", "Saved on this phone only");
      return scheduleRetry();
    }

    saving = true;
    setSave("ok", "Saving…");
    try {
      const res = await sessionApi.save(state.token, pending);
      saving = false;
      if (res.accepted === false) return goToResult(res.reason === "time_up" ? "time_up" : "already_submitted");
      applyServerClock(res);
      store.markSaved(idsOf(pending));
      hideOffline();
      setSave("ok", "All answers saved");
      if (store.pendingAnswers().length > 0) queueSave(); // something was typed while this was in flight
    } catch (err) {
      saving = false;
      if (err instanceof NetworkError) {
        showOffline();
        setSave("warn", "Saved on this phone only");
        return scheduleRetry();
      }
      if (isExpiredSession(err)) return ctx.onSessionLost(err.message);
      setSave("warn", err.message || "This answer could not be saved.");
    }
  }

  function applyServerClock(res) {
    if (res && res.server_time) store.setServerTime(res.server_time);
    if (res && res.ends_at) {
      state.session.ends_at = res.ends_at;
      state.session.remaining_seconds = res.remaining_seconds;
    }
  }

  // ---------- timer ----------
  const remaining = () => (Date.parse(state.session.ends_at) - store.serverNowMs()) / 1000;

  function tick() {
    const left = remaining();
    timerEl.replaceChildren(icon("clock"), h("span", {}, clockText(left)));
    timerEl.classList.toggle("low", left <= 300);
    if (left <= 0) {
      clearInterval(tickTimer);
      timeUp();
    }
  }

  async function timeUp() {
    if (submitted) return;
    setSave("ok", "Time is up. Sending your test…");
    await flush(); // whatever is on this phone still reaches the server inside its grace period (BR-20)
    await submitTest("time_up");
  }

  // ---------- heartbeat ----------
  async function heartbeat() {
    if (submitted) return;
    try {
      const res = await sessionApi.heartbeat(state.token);
      applyServerClock(res);
      state.session.tab_switch_count = res.tab_switch_count;
      if (res.status && res.status !== "in_progress" && res.status !== "reopened") {
        return goToResult(res.status === "timed_out" ? "time_up" : "already_submitted");
      }
    } catch (err) {
      if (isExpiredSession(err)) return ctx.onSessionLost(err.message);
      /* a missed heartbeat must not interrupt the student */
    }
  }

  // ---------- session events (anti-cheating, design section 4) ----------
  async function logEvent(type, meta) {
    if (submitted) return null;
    try {
      const res = await sessionApi.event(state.token, type, meta || {});
      state.session.tab_switch_count = res.tab_switch_count;
      if (res.autosubmit) {
        submitted = true;
        stopTimers();
        return goToResult("tab_switch_limit");
      }
      return res;
    } catch (err) {
      if (isExpiredSession(err)) ctx.onSessionLost(err.message);
      return null;
    }
  }

  async function onHidden() {
    const res = await logEvent("tab_hidden", { at: new Date().toISOString() });
    if (!res || submitted) return;
    if (res.tab_switch_count >= res.warn_limit) showLeaveWarning(res);
  }

  function showLeaveWarning(res) {
    const left = Math.max(0, res.autosubmit_limit - res.tab_switch_count);
    confirmDialog({
      title: "You left the test page",
      message: `This was recorded and your teacher can see it. You have left the page ${res.tab_switch_count} ${res.tab_switch_count === 1 ? "time" : "times"}. `
        + (left > 0
          ? `Your test is submitted automatically after ${res.autosubmit_limit} times (${left} more).`
          : "Your test was submitted automatically."),
      confirmLabel: "Back to the test",
      cancelLabel: "Close",
    });
  }

  // ---------- question navigation ----------
  function showQuestion(next) {
    index = Math.max(0, Math.min(total - 1, next));
    const question = state.questions[index];
    block = questionBlock(question, state.media, {
      value: (id) => store.textOf(id),
      onAnswer: (id, text) => {
        if (!store.setText(id, text)) return;
        setSave("ok", "Saving…");
        queueSave();
        refreshChrome();
      },
    });
    body.replaceChildren(block.el);
    body.scrollTop = 0;
    refreshChrome();
  }

  function refreshChrome() {
    const { answered, flagged } = store.progress();
    counter.textContent = `Question ${index + 1} of ${total}`;
    progress.style.width = `${total ? Math.round((answered / total) * 100) : 0}%`;
    const marked = !!(requestId() && store.answerOf(requestId()).is_flagged);
    markBtn.classList.toggle("on", marked);
    markBtn.setAttribute("aria-pressed", String(marked));
    markLabel.textContent = marked ? "Marked" : "Mark";
    markBtn.setAttribute("aria-label", marked ? "Remove the mark" : "Mark for review");
    prevBtn.disabled = index === 0;
    const last = index === total - 1;
    nextBtn.replaceChildren(h("span", {}, last ? "Finish" : "Next"), icon(last ? "check" : "right"));
    if (sheet) paintSheet();
  }

  // ---------- answer sheet ----------
  function closeSheet() {
    if (sheet) sheet.remove();
    if (dim) dim.remove();
    sheet = null;
    dim = null;
  }

  function paintSheet() {
    if (!sheet) return;
    const grid = sheet.querySelector(".sheetgrid");
    const { answered, empty } = store.progress();
    sheet.querySelector(".sub").textContent = `${answered} answered, ${empty} still empty.`;
    const cells = grid.children;
    for (let i = 0; i < cells.length; i++) {
      const questionId = state.questions[i].question_id;
      cells[i].classList.toggle("answered", store.isAnswered(questionId));
      cells[i].classList.toggle("marked", !!store.answerOf(questionId).is_flagged);
      cells[i].classList.toggle("current", i === index);
    }
  }

  function openSheet() {
    closeSheet();
    const grid = h("div", { class: "sheetgrid" }, state.questions.map((question, i) =>
      h("button", {
        type: "button",
        onclick: () => { closeSheet(); showQuestion(i); },
        "aria-label": `Question ${i + 1}${store.isAnswered(question.question_id) ? ", answered" : ", still empty"}`,
      }, String(i + 1))));
    sheet = h("div", { class: "sheet", role: "dialog", "aria-label": "Answer sheet" },
      h("div", { class: "grab" }),
      h("h2", {}, "Answer sheet"),
      h("div", { class: "sub" }, ""),
      h("div", { class: "legend" },
        h("span", {}, h("i", { class: "bubble" }), "Answered"),
        h("span", {}, h("i", { class: "bubble", style: "background:#fff;border-color:var(--line)" }), "Empty"),
        h("span", {}, h("i", { class: "bubble mk" }), "Marked")),
      grid,
      h("button", { class: "btn ghost block", type: "button", style: "margin-bottom:8px", onclick: closeSheet }, "Back to question"),
      h("button", { class: "btn block", type: "button", onclick: () => { closeSheet(); askSubmit(); } }, "Submit test"),
      h("p", { class: "hint", style: "text-align:center;margin-top:10px" }, "You will be asked to confirm before it is sent."));
    dim = h("div", { class: "dim", onclick: closeSheet });
    document.body.append(dim, sheet);
    paintSheet();
  }

  // ---------- submit ----------
  async function askSubmit() {
    const { empty } = store.progress();
    const ok = await confirmDialog({
      title: "Send your test?",
      message: empty > 0
        ? `${empty} ${empty === 1 ? "question is" : "questions are"} still empty. You cannot change your answers after sending.`
        : "You answered every question. You cannot change your answers after sending.",
      confirmLabel: "Send my test",
      cancelLabel: "Keep working",
    });
    if (ok) submitTest("student");
  }

  async function submitTest(reason) {
    if (submitting || submitted) return;
    submitting = true;
    setSave("ok", "Sending your test…");
    try {
      const pending = store.pendingAnswers();
      if (pending.length > 0) {
        try {
          const res = await sessionApi.save(state.token, pending);
          if (res && res.accepted !== false) store.markSaved(idsOf(pending));
        } catch {
          /* the submit below carries the authoritative state; a lost save must not block it */
        }
      }
      const result = await sessionApi.submit(state.token, reason);
      submitted = true;
      stopTimers();
      ctx.onSubmitted(result, reason);
    } catch (err) {
      submitting = false;
      if (isExpiredSession(err)) return ctx.onSessionLost(err.message);
      if (err instanceof NetworkError) {
        showOffline();
        setSave("warn", "No connection. Your test is still on this phone — it will be sent as soon as you are back online.");
        return scheduleRetry();
      }
      setSave("warn", err.message || "Could not send your test. Please try again.");
    }
  }

  /** The server already closed the session (time up, the tab limit, or a teacher action). */
  async function goToResult(reason) {
    if (submitted && !reason) return;
    submitted = true;
    stopTimers();
    try {
      const result = await sessionApi.result(state.token);
      ctx.onSubmitted(result, reason);
    } catch (err) {
      if (isExpiredSession(err)) return ctx.onSessionLost(err.message);
      ctx.onSubmitted({ submitted: true, status: "auto_submitted", visibility: "none", pending_review: false, pass_status: "not_final" }, reason);
    }
  }

  function stopTimers() {
    clearInterval(tickTimer);
    clearInterval(beatTimer);
    clearTimeout(saveTimer);
    clearTimeout(retryTimer);
    tickTimer = beatTimer = saveTimer = retryTimer = null;
  }

  // ---------- wiring ----------
  markBtn.addEventListener("click", () => {
    const id = requestId();
    if (!id) return;
    store.toggleFlag(id);
    queueSave();
    refreshChrome();
  });
  sheetBtn.addEventListener("click", openSheet);
  prevBtn.addEventListener("click", () => showQuestion(index - 1));
  nextBtn.addEventListener("click", () => (index === total - 1 ? askSubmit() : showQuestion(index + 1)));

  const onVisibility = () => { if (document.hidden) onHidden(); };
  const onBlur = () => {
    if (document.hidden) return; // a real tab switch is already recorded
    const now = Date.now();
    if (now - lastBlurLogged < BLUR_THROTTLE_MS) return;
    lastBlurLogged = now;
    logEvent("blur", { at: new Date(now).toISOString() });
  };
  const onOnline = () => {
    hideOffline();
    logEvent("online");
    store.markAllPending();
    flush();
  };
  const onOffline = () => {
    showOffline();
    setSave("warn", "Saved on this phone only");
    logEvent("offline");
  };

  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("blur", onBlur);
  window.addEventListener("online", onOnline);
  window.addEventListener("offline", onOffline);

  /** Lets the app tidy up when the screen is replaced. */
  function destroy() {
    stopTimers();
    closeSheet();
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("blur", onBlur);
    window.removeEventListener("online", onOnline);
    window.removeEventListener("offline", onOffline);
  }

  // ---------- first paint ----------
  mount(root,
    h("main", { class: "phone" },
      h("div", { class: "qtop" },
        counter,
        h("span", { class: "exam-title" }, exam.title),
        timerEl),
      h("div", { class: "bar" }, progress),
      saveLine,
      offlineBar,
      body,
      h("div", { class: "qnav" }, sheetBtn, markBtn, prevBtn, nextBtn)));

  showQuestion(0);
  setSave("ok", store.pendingAnswers().length > 0 ? "Saving…" : "All answers saved");
  if (navigator.onLine === false) onOffline();
  tick();
  tickTimer = setInterval(tick, 1000);
  beatTimer = setInterval(heartbeat, HEARTBEAT_MS);

  return { destroy, flush };
}
