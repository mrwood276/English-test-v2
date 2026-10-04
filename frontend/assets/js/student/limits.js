/**
 * How long one answer may be, on this side of the wire.
 *
 * The authority is `public.save_session_answers` in
 * `supabase/migrations/20260923000000_session_functions.sql`: an essay may hold 20,000 characters,
 * every other kind of answer 1,000 — one answer over its limit refuses the whole save batch. The Edge
 * parser ceiling in `backend/functions/session/parse.ts` is only a body guard (it cannot know the
 * question's type), so the screen checks the real rule here before it queues an answer, and names the
 * question loudly if the server refuses one anyway (INS-02).
 *
 * `frontend/tests/unit/student_limits.test.ts` reads the SQL and fails if these numbers drift from it.
 */
export const ANSWER_CHARS_LIMIT = 1_000;
export const ESSAY_CHARS_LIMIT = 20_000;

/** The limit for one question, by its type. Anything that is not an essay is a short answer. */
export const answerLimit = (
  type,
) => (type === "essay" ? ESSAY_CHARS_LIMIT : ANSWER_CHARS_LIMIT);
