import assert from "node:assert/strict";
import { createHandler, type Db } from "../functions/results/handler.ts";
import { asFeedback, asPoints, asSeconds } from "../functions/results/parse.ts";
import { ApiError } from "../functions/_shared/errors.ts";

const TEACHER = "11111111-1111-4111-8111-111111111111";
const EXAM = "22222222-2222-4222-8222-222222222222";
const SESSION = "33333333-3333-4333-8333-333333333333";
const QUESTION = "44444444-4444-4444-8444-444444444444";

interface Call { name: string; args: Record<string, unknown> }

function fakeDb(rpcResult: (name: string, args: Record<string, unknown>) => { data?: unknown; error?: { message: string; hint?: string; code?: string } } = () => ({ data: null }), role: "teacher" | "admin" | null = "teacher") {
  const calls: Call[] = [];
  const db: Db = {
    auth: { getUser: (t: string) => Promise.resolve(t === "good" ? { data: { user: { id: TEACHER } }, error: null } : { data: { user: null }, error: { message: "bad" } }) },
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: role ? { id: TEACHER, full_name: "Ms. Rina", role, is_active: true } : null, error: null }) }) }) }),
    rpc: (name: string, args: Record<string, unknown> = {}) => {
      calls.push({ name, args });
      const r = rpcResult(name, args);
      return Promise.resolve({ data: r.data ?? null, error: r.error ?? null });
    },
  };
  return { db, calls };
}

const post = (body: unknown, token: string | null = "good") =>
  new Request("http://x/", { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });

// ---------- parsing ----------
Deno.test("asSeconds turns the screen's minutes into seconds", () => {
  assert.equal(asSeconds(5, "Minutes"), 300);
  assert.equal(asSeconds(120, "Minutes"), 7200);
  assert.throws(() => asSeconds(0, "Minutes"), (err: unknown) => err instanceof ApiError && /between 1 and 120/.test(err.message));
  assert.throws(() => asSeconds(121, "Minutes"), ApiError);
  assert.throws(() => asSeconds(2.5, "Minutes"), (err: unknown) => err instanceof ApiError && /whole number/.test(err.message));
});

Deno.test("asPoints keeps at most two decimals and refuses nonsense", () => {
  assert.equal(asPoints(3, "Points"), 3);
  assert.equal(asPoints(2.666, "Points"), 2.67);
  assert.equal(asPoints(0, "Points"), 0);
  assert.throws(() => asPoints(-1, "Points"), (err: unknown) => err instanceof ApiError && /between 0 and 1000/.test(err.message));
  assert.throws(() => asPoints("3", "Points"), ApiError);
});

Deno.test("asFeedback turns blank comments into null and limits the length", () => {
  assert.equal(asFeedback(undefined), null);
  assert.equal(asFeedback(null), null);
  assert.equal(asFeedback("   "), null);
  assert.equal(asFeedback("  Good on who and where.  "), "Good on who and where.");
  assert.throws(() => asFeedback("x".repeat(2001)), (err: unknown) => err instanceof ApiError && /at most 2000/.test(err.message));
});

// ---------- handler ----------
Deno.test("activity defaults to real exams and can include templates", async () => {
  const { db, calls } = fakeDb(() => ({ data: [{ exam_id: EXAM }] }));
  const h = createHandler(() => db);
  assert.deepEqual(await (await h(post({ action: "activity" }))).json(), { exams: [{ exam_id: EXAM }] });
  assert.equal(calls[0].name, "list_exam_activity");
  assert.equal(calls[0].args.p_include_templates, false, "templates stay out unless asked for");
  await h(post({ action: "activity", include_templates: true }));
  assert.equal(calls[1].args.p_include_templates, true);
});

Deno.test("pending returns the badge number", async () => {
  const { db, calls } = fakeDb(() => ({ data: 9 }));
  const res = await createHandler(() => db)(post({ action: "pending" }));
  assert.deepEqual(await res.json(), { pending: 9 });
  assert.equal(calls[0].name, "count_pending_grading");
});

Deno.test("overview returns the exam results and 404s a missing exam", async () => {
  const { db, calls } = fakeDb(() => ({ data: { summary: { passed: 3 }, rows: [] } }));
  const res = await createHandler(() => db)(post({ action: "overview", exam_id: EXAM }));
  assert.deepEqual(await res.json(), { overview: { summary: { passed: 3 }, rows: [] } });
  assert.equal(calls[0].name, "list_exam_results");
  assert.equal(calls[0].args.p_exam_id, EXAM);

  const empty = fakeDb(() => ({ data: null }));
  assert.equal((await createHandler(() => empty.db)(post({ action: "overview", exam_id: EXAM }))).status, 404);
});

Deno.test("report, grading_questions and queue pass their ids", async () => {
  const { db, calls } = fakeDb(() => ({ data: { ok: true } }));
  const h = createHandler(() => db);
  await h(post({ action: "report", session_id: SESSION }));
  await h(post({ action: "grading_questions", exam_id: EXAM }));
  await h(post({ action: "queue", exam_id: EXAM, question_id: QUESTION }));
  assert.deepEqual(calls.map((c) => c.name), ["get_session_report", "list_grading_questions", "get_grading_queue"]);
  assert.equal(calls[0].args.p_session_id, SESSION);
  assert.equal(calls[1].args.p_exam_id, EXAM);
  assert.equal(calls[2].args.p_exam_id, EXAM);
  assert.equal(calls[2].args.p_question_id, QUESTION);
});

Deno.test("grade sends points, rounded, with the teacher as the actor", async () => {
  const { db, calls } = fakeDb(() => ({ data: { saved: true, final: true } }));
  const res = await createHandler(() => db)(post({ action: "grade", session_id: SESSION, question_id: QUESTION, points: 2.666, feedback: "  Good.  " }));
  assert.deepEqual(await res.json(), { grade: { saved: true, final: true } });
  assert.equal(calls[0].name, "save_answer_grade");
  assert.equal(calls[0].args.p_points, 2.67);
  assert.equal(calls[0].args.p_feedback, "Good.");
  assert.equal(calls[0].args.p_actor, TEACHER);
});

Deno.test("grade without a comment sends null, not an empty string", async () => {
  const { db, calls } = fakeDb(() => ({ data: {} }));
  await createHandler(() => db)(post({ action: "grade", session_id: SESSION, question_id: QUESTION, points: 3 }));
  assert.equal(calls[0].args.p_feedback, null);
});

Deno.test("grade refuses a missing or negative number before touching the database", async () => {
  const { db, calls } = fakeDb();
  const h = createHandler(() => db);
  assert.equal((await h(post({ action: "grade", session_id: SESSION, question_id: QUESTION }))).status, 400);
  assert.equal((await h(post({ action: "grade", session_id: SESSION, question_id: QUESTION, points: -1 }))).status, 400);
  assert.equal(calls.length, 0);
});

Deno.test("add_time and reopen talk in minutes and pass the actor", async () => {
  const { db, calls } = fakeDb(() => ({ data: { status: "reopened" } }));
  const h = createHandler(() => db);
  await h(post({ action: "add_time", session_id: SESSION, minutes: 5 }));
  await h(post({ action: "reopen", session_id: SESSION, minutes: 10 }));
  assert.deepEqual(calls.map((c) => c.name), ["add_session_time", "reopen_session"]);
  assert.equal(calls[0].args.p_seconds, 300);
  assert.equal(calls[1].args.p_seconds, 600);
  assert.equal(calls[0].args.p_actor, TEACHER);
  assert.equal(calls[1].args.p_session_id, SESSION);
});

Deno.test("add_time refuses a window the database would reject anyway", async () => {
  const { db, calls } = fakeDb();
  const h = createHandler(() => db);
  assert.equal((await h(post({ action: "add_time", session_id: SESSION, minutes: 0 }))).status, 400);
  assert.equal((await h(post({ action: "add_time", session_id: SESSION, minutes: 180 }))).status, 400);
  assert.equal((await h(post({ action: "reopen", session_id: SESSION, minutes: 1.5 }))).status, 400);
  assert.equal(calls.length, 0);
});

Deno.test("add_exam_time gives the whole exam time in one call", async () => {
  const { db, calls } = fakeDb(() => ({ data: { updated: 3, added_seconds: 300 } }));
  const h = createHandler(() => db);
  const res = await h(post({ action: "add_exam_time", exam_id: EXAM, minutes: 5 }));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { added: { updated: 3, added_seconds: 300 } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "add_exam_time");
  assert.equal(calls[0].args.p_exam_id, EXAM);
  assert.equal(calls[0].args.p_seconds, 300);
  assert.equal(calls[0].args.p_actor, TEACHER);
});

Deno.test("add_exam_time takes the same window as one session's time", async () => {
  const { db, calls } = fakeDb();
  const h = createHandler(() => db);
  assert.equal((await h(post({ action: "add_exam_time", exam_id: EXAM, minutes: 0 }))).status, 400);
  assert.equal((await h(post({ action: "add_exam_time", exam_id: EXAM, minutes: 121 }))).status, 400);
  assert.equal((await h(post({ action: "add_exam_time", minutes: 5 }))).status, 400);
  assert.equal(calls.length, 0);
});

Deno.test("retake actions pass the session and the actor", async () => {
  const { db, calls } = fakeDb(() => ({ data: { granted: true } }));
  const h = createHandler(() => db);
  await h(post({ action: "grant_retake", session_id: SESSION }));
  await h(post({ action: "revoke_retake", session_id: SESSION }));
  assert.deepEqual(calls.map((c) => c.name), ["grant_retake", "revoke_retake"]);
  assert.equal(calls[0].args.p_actor, TEACHER);
  assert.equal(calls[1].args.p_session_id, SESSION);
});

Deno.test("a bad id or an unknown action is refused without a database call", async () => {
  const { db, calls } = fakeDb();
  const h = createHandler(() => db);
  assert.equal((await h(post({ action: "overview", exam_id: "nope" }))).status, 400);
  assert.equal((await h(post({ action: "grade", session_id: "nope", question_id: QUESTION, points: 1 }))).status, 400);
  assert.equal((await h(post({ action: "eat_the_exam" }))).status, 400);
  assert.equal((await h(post({}))).status, 400);
  assert.equal(calls.length, 0);
});

Deno.test("validation-hinted SQL errors become friendly 400s", async () => {
  const { db } = fakeDb(() => ({ error: { message: "The most points this question can give is 3.", hint: "validation" } }));
  const res = await createHandler(() => db)(post({ action: "grade", session_id: SESSION, question_id: QUESTION, points: 4 }));
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /most points/);
});

Deno.test("unexpected SQL errors stay hidden from the person", async () => {
  const { db } = fakeDb(() => ({ error: { message: "password authentication failed for user postgres" } }));
  const orig = console.error; console.error = () => {};
  const res = await createHandler(() => db)(post({ action: "overview", exam_id: EXAM }));
  console.error = orig;
  assert.equal(res.status, 500);
  assert.ok(!JSON.stringify(await res.json()).includes("password"));
});

Deno.test("requires a signed-in staff member; only POST is allowed", async () => {
  const { db, calls } = fakeDb();
  const h = createHandler(() => db);
  assert.equal((await h(post({ action: "pending" }, null))).status, 401);
  assert.equal((await h(post({ action: "pending" }, "bad"))).status, 401);
  assert.equal((await createHandler(() => fakeDb(() => ({}), null).db)(post({ action: "pending" }))).status, 403);
  assert.equal((await h(new Request("http://x/", { method: "GET", headers: { authorization: "Bearer good" } }))).status, 405);
  assert.equal(calls.length, 0, "nothing reaches the database without access");
});

Deno.test("an admin passes the same way as a teacher", async () => {
  const { db, calls } = fakeDb(() => ({ data: 1 }), "admin");
  const res = await createHandler(() => db)(post({ action: "pending" }));
  assert.equal(res.status, 200);
  assert.equal(calls.length, 1);
});
