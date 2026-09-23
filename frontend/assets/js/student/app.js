import { sessionApi, isExpiredSession, NetworkError } from "./api.js";
import * as store from "./store.js";
import { renderJoin } from "./screens/join.js";
import { renderExam } from "./screens/exam.js";
import { renderResult } from "./screens/result.js";

/**
 * The student app is a short, linear flow, not a navigable site: join → take the test → see the
 * result. The hash is kept in step only so a reload lands in the right place; the real "where am I"
 * answer comes from the session status the server reports.
 */
const root = document.getElementById("app");
let examScreen = null;

const setHash = (hash) => {
  try {
    history.replaceState(null, "", hash);
  } catch {
    /* an odd browser or a file:// URL: the hash is cosmetic */
  }
};

function destroyExam() {
  if (examScreen) {
    examScreen.destroy();
    examScreen = null;
  }
}

function showJoin(notice) {
  destroyExam();
  store.reset();
  setHash("#/join");
  renderJoin(root, {
    notice,
    onJoined: async (data) => {
      store.hydrate(data);
      if (data.session && data.session.server_time) store.setServerTime(data.session.server_time);
      await loadMedia();
      showExam();
    },
  });
}

function showExam() {
  destroyExam();
  setHash("#/exam");
  examScreen = renderExam(root, {
    onSubmitted: (result, reason) => showResult(result, reason),
    onSessionLost: (message) => showJoin(message),
  });
}

function showResult(result, reason) {
  destroyExam();
  setHash("#/result");
  store.persist(); // the token and the name stay, so a reload can show this result again
  renderResult(root, result, { onDone: () => showJoin() }, { reason });
}

/** Signed links for the pictures and audio of this session (the bucket stays private). */
async function loadMedia() {
  try {
    const res = await sessionApi.media(store.state.token);
    store.state.media = res.urls || {};
    store.state.mediaFetchedAt = Date.now();
  } catch {
    /* a missing picture or player must never stop a test */
  }
}

async function boot() {
  if (!store.loadStored()) return showJoin();
  try {
    const data = await sessionApi.get(store.state.token);
    store.hydrate(data);
    if (data.session && data.session.server_time) store.setServerTime(data.session.server_time);
    if (data.session.status === "in_progress" || data.session.status === "reopened") {
      await loadMedia();
      return showExam();
    }
    const result = await sessionApi.result(store.state.token);
    showResult(result);
  } catch (err) {
    if (isExpiredSession(err)) return showJoin("That test session has ended. Please join again with the code on the board.");
    // No connection but the questions are still on this phone: the student can keep working.
    if (err instanceof NetworkError && store.state.questions.length > 0) return showExam();
    showJoin(err.message || "Could not reach the server. Please try again.");
  }
}

boot();
