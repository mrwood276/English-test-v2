/**
 * What the student's phone remembers:
 *   - the session token (the only way back into the session after a reload or a lost connection),
 *   - the question snapshot the server gave us,
 *   - every answer typed here, including the ones still waiting to be sent.
 *
 * The server stays the source of truth: after a reload we ask it for the session and then let the
 * answers that were never acknowledged win (BR-12), so nothing the student typed is lost offline.
 */
const KEY = "ENGLISH_TEST_V2_STUDENT_SESSION";

export const state = {
  token: null,
  session: null, // { id, status, attempt_no, student_name, student_class, started_at, ends_at, remaining_seconds, grace_seconds, tab_switch_count, exam }
  questions: [], // snapshot from the server (never contains the answer key)
  answers: {}, // questionId -> { text, is_flagged, pending }
  media: {}, // media id -> signed url (short lived)
  mediaFetchedAt: 0,
  serverOffsetMs: 0, // server time minus this phone's clock, so the timer follows the server
};

export function reset() {
  state.token = null;
  state.session = null;
  state.questions = [];
  state.answers = {};
  state.media = {};
  state.mediaFetchedAt = 0;
  state.serverOffsetMs = 0;
  clearStored();
}

const emptyAnswer = () => ({ text: "", is_flagged: false, pending: false });

export function answerOf(questionId) {
  return state.answers[questionId] || (state.answers[questionId] = emptyAnswer());
}

export function textOf(questionId) {
  return answerOf(questionId).text;
}

export function setText(questionId, text) {
  const answer = answerOf(questionId);
  if (answer.text === text) return false;
  answer.text = text;
  answer.pending = true;
  persist();
  return true;
}

export function toggleFlag(questionId) {
  const answer = answerOf(questionId);
  answer.is_flagged = !answer.is_flagged;
  answer.pending = true;
  persist();
  return answer.is_flagged;
}

export function isAnswered(questionId) {
  return String(textOf(questionId)).trim() !== "";
}

/** The answers that still need to reach the server, shaped for the session function. */
export function pendingAnswers() {
  const now = new Date().toISOString();
  return Object.entries(state.answers)
    .filter(([, answer]) => answer.pending)
    .map(([questionId, answer]) => ({
      question_id: questionId,
      answer: { text: answer.text ?? "" },
      is_flagged: !!answer.is_flagged,
      client_saved_at: now,
    }));
}

/** Called after a successful save: those answers are on the server now. */
export function markSaved(questionIds) {
  for (const id of questionIds) {
    const answer = state.answers[id];
    if (answer) answer.pending = false;
  }
  persist();
}

/** Marks everything as needing a save (after the connection came back). */
export function markAllPending() {
  for (const answer of Object.values(state.answers)) answer.pending = true;
  persist();
}

export function progress() {
  const total = state.questions.length;
  let answered = 0;
  let flagged = 0;
  for (const question of state.questions) {
    if (isAnswered(question.question_id)) answered += 1;
    if (answerOf(question.question_id).is_flagged) flagged += 1;
  }
  return { total, answered, empty: total - answered, flagged };
}

export function indexOf(questionId) {
  return state.questions.findIndex((q) => q.question_id === questionId);
}

/** Takes a `join`/`get` payload and merges it with what is already on this phone. */
export function hydrate(payload, { keepLocal = true } = {}) {
  if (payload.token) state.token = payload.token;
  state.session = payload.session;
  state.questions = payload.questions || [];
  const fromServer = {};
  for (const entry of payload.answers || []) {
    fromServer[entry.question_id] = {
      text: (entry.answer && entry.answer.text) || "",
      is_flagged: !!entry.is_flagged,
      pending: false,
    };
  }
  const merged = {};
  for (const question of state.questions) {
    const id = question.question_id;
    const local = state.answers[id];
    const server = fromServer[id] || emptyAnswer();
    // An answer typed here that never reached the server must not be overwritten (BR-12).
    merged[id] = keepLocal && local && local.pending && local.text !== server.text
      ? { ...local, pending: true }
      : server;
  }
  state.answers = merged;
  persist();
}

/** Restores the remembered session (used at boot, before the server is asked). */
export function loadStored() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return false;
    const data = JSON.parse(raw);
    if (!data || typeof data.token !== "string") return false;
    state.token = data.token;
    state.session = data.session || null;
    state.questions = Array.isArray(data.questions) ? data.questions : [];
    state.answers = data.answers && typeof data.answers === "object" ? data.answers : {};
    return true;
  } catch {
    return false;
  }
}

export function persist() {
  try {
    localStorage.setItem(KEY, JSON.stringify({
      token: state.token,
      session: state.session,
      questions: state.questions,
      answers: state.answers,
    }));
  } catch {
    /* private mode or a full disk: the session still works in memory */
  }
}

export function clearStored() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* nothing to do */
  }
}

/** Server time (ISO) → milliseconds, used to keep the timer honest. */
export function serverNowMs() {
  return Date.now() + (state.serverOffsetMs || 0);
}

export function setServerTime(iso) {
  const parsed = Date.parse(iso);
  if (!Number.isNaN(parsed)) state.serverOffsetMs = parsed - Date.now();
}
