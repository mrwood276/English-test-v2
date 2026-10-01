import assert from "node:assert/strict";
// @ts-ignore — plain JavaScript shared with the browser
import { ANSWER_CHARS_LIMIT, answerLimit, ESSAY_CHARS_LIMIT } from "../../assets/js/student/limits.js";

// The database function is the authority for these caps: an answer over its limit refuses the whole
// save batch, which is exactly the loop INS-02 describes. The screen's copy must not drift from it.
const SQL = await Deno.readTextFile(
  new URL("../../../supabase/migrations/20260923000000_session_functions.sql", import.meta.url),
);
const PARSE = await Deno.readTextFile(new URL("../../../backend/functions/session/parse.ts", import.meta.url));

const sqlCaps = () => {
  const found = /case when v_type = 'essay' then (\d+) else (\d+) end/.exec(SQL);
  assert.ok(found, "save_session_answers no longer states its per-type answer caps in one line");
  return { essay: Number(found![1]), other: Number(found![2]) };
};

Deno.test("the phone's answer caps are the caps save_session_answers enforces", () => {
  const { essay, other } = sqlCaps();
  assert.equal(ESSAY_CHARS_LIMIT, essay, "the essay cap on the phone is not the database's");
  assert.equal(ANSWER_CHARS_LIMIT, other, "the non-essay cap on the phone is not the database's");
  assert.equal(answerLimit("essay"), essay);
  assert.equal(answerLimit("short_answer"), other);
  assert.equal(answerLimit("multiple_choice"), other);
  assert.equal(answerLimit("true_false"), other);
});

Deno.test("the edge parser's ceiling admits the biggest answer the database accepts", () => {
  const found = /MAX_ANSWER_CHARS = ([\d_]+)/.exec(PARSE);
  assert.ok(found, "backend/functions/session/parse.ts no longer declares MAX_ANSWER_CHARS");
  const ceiling = Number(found![1].replace(/_/g, ""));
  assert.ok(ceiling >= ESSAY_CHARS_LIMIT, `the parser ceiling (${ceiling}) is below the essay cap`);
});
