import assert from "node:assert/strict";
import { createHandler, type Db } from "../functions/exams/handler.ts";
import { parseExamInput, parseListFilters, asAccessCode, asTimestamp } from "../functions/exams/parse.ts";
import { callRpc } from "../functions/_shared/rpc.ts";
import { ApiError } from "../functions/_shared/errors.ts";

const TEACHER = "11111111-1111-4111-8111-111111111111";
const EXAM = "22222222-2222-4222-8222-222222222222";

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

const validExam = {
  action: "save",
  title: "Narrative Text, Daily Test 3",
  duration_minutes: 45,
  passing_grade: 70,
  availability_mode: "scheduled",
  starts_at: "2026-09-22T09:45",
  ends_at: "2026-09-22T10:30",
  late_start_policy: "cut_at_end",
  access_code: " k7m2qx ",
  selection_mode: "manual",
  questions: [{ question_id: "33333333-3333-4333-8333-333333333331", weight: 2 }],
  randomize_questions: true,
  result_visibility: "score_and_review",
};

// ---------- parsing ----------
Deno.test("parseExamInput cleans title, code, and shapes defaults", () => {
  const { id, payload } = parseExamInput(validExam);
  assert.equal(id, undefined);
  assert.equal(payload.title, "Narrative Text, Daily Test 3");
  assert.equal(payload.access_code, "K7M2QX", "code is normalized (case, spaces)");
  assert.equal(payload.availability_mode, "scheduled");
  assert.equal(payload.late_start_policy, "cut_at_end");
  assert.equal(payload.passing_grade, 70);
  assert.deepEqual(payload.questions, [{ question_id: "33333333-3333-4333-8333-333333333331", weight: 2 }]);
  assert.equal(payload.tab_switch_warn_limit, 1);
  assert.equal(payload.tab_switch_flag_limit, 3);
  assert.equal(payload.tab_switch_autosubmit_limit, 5, "defaults 1/3/5 per the design");
  assert.equal(payload.is_template, false);
  assert.equal(payload.auto_filter, null);
  assert.equal(payload.pool_size, null);
});

Deno.test("parseExamInput keeps id for updates and accepts blank optionals", () => {
  const { id, payload } = parseExamInput({ ...validExam, id: EXAM, passing_grade: "", description: "  ", status: "" });
  assert.equal(id, EXAM);
  assert.equal(payload.passing_grade, 0);
  assert.equal(payload.description, null);
  assert.equal(payload.status, "draft");
});

Deno.test("parseExamInput rejects closing time before opening time", () => {
  assert.throws(() => parseExamInput({ ...validExam, starts_at: "2026-09-22T10:30", ends_at: "2026-09-22T09:45" }), (err: unknown) => err instanceof ApiError && /Closing time must be after/.test(err.message));
});

Deno.test("parseExamInput requires schedule for scheduled availability", () => {
  const noEnd = { ...validExam } as Record<string, unknown>;
  delete noEnd.ends_at;
  assert.throws(() => parseExamInput(noEnd), (err: unknown) => err instanceof ApiError && /Closing time is required/.test(err.message));
});

Deno.test("parseExamInput validates the code shape", () => {
  assert.throws(() => parseExamInput({ ...validExam, access_code: "AB!2" }), (err: unknown) => err instanceof ApiError && /4 to 12 letters and digits/.test(err.message));
  assert.throws(() => parseExamInput({ ...validExam, access_code: "" }), (err: unknown) => err instanceof ApiError && /at least 4 characters/.test(err.message));
});

Deno.test("parseExamInput keeps tab limits ordered warn <= flag <= autosubmit", () => {
  assert.throws(
    () => parseExamInput({ ...validExam, tab_switch_warn_limit: 5, tab_switch_flag_limit: 3, tab_switch_autosubmit_limit: 3 }),
    (err: unknown) => err instanceof ApiError && /must grow/.test(err.message),
  );
});

Deno.test("parseExamInput shapes the auto-selection filter", () => {
  const { payload } = parseExamInput({
    ...validExam, selection_mode: "auto", questions: [],
    auto_filter: { topic: "Narrative Text", difficulty: "medium" }, pool_size: 40, draw_per_student: true,
  });
  assert.deepEqual(payload.auto_filter, { topic: "Narrative Text", difficulty: "medium" });
  assert.equal(payload.pool_size, 40);
  assert.equal(payload.draw_per_student, true);
});

Deno.test("parseExamInput refuses an auto exam without any filter", () => {
  assert.throws(() => parseExamInput({ ...validExam, selection_mode: "auto", auto_filter: {} }), (err: unknown) => err instanceof ApiError && /Selection filter needs/.test(err.message));
});

Deno.test("parseListFilters passes only what was asked", () => {
  assert.deepEqual(parseListFilters({ q: "quiz", status: "open", sort: "title", page: 2, page_size: 10 }), { q: "quiz", status: "open", sort: "title", page: 2, page_size: 10 });
  assert.deepEqual(parseListFilters({}), {});
  assert.deepEqual(parseListFilters({ template_only: true }), { template_only: true });
});

Deno.test("asAccessCode normalizes lowercase and stray spaces", () => {
  assert.equal(asAccessCode(" k7m 2qx ", "code"), "K7M2QX");
  assert.throws(() => asAccessCode("too long code!", "code"), ApiError);
});

Deno.test("asTimestamp accepts local input and returns ISO", () => {
  assert.equal(asTimestamp("2026-09-22T09:45", "t"), new Date("2026-09-22T09:45").toISOString());
  assert.throws(() => asTimestamp("not a date", "t"), (err: unknown) => err instanceof ApiError && /not a valid date/.test(err.message));
});

// ---------- handler (returns Response, like the question-bank handler) ----------
Deno.test("save maps to save_exam with the actor id and returns the new id", async () => {
  const { db, calls } = fakeDb(() => ({ data: EXAM }));
  const res = await createHandler(() => db)(post(validExam));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { id: EXAM });
  assert.equal(calls[0].name, "save_exam");
  assert.equal(calls[0].args.p_actor, TEACHER);
  assert.equal(calls[0].args.p_id, null);
});

Deno.test("save passes the id on updates", async () => {
  const { db, calls } = fakeDb(() => ({ data: EXAM }));
  await createHandler(() => db)(post({ ...validExam, id: EXAM }));
  assert.equal(calls[0].args.p_id, EXAM);
});

Deno.test("list returns the exams list with cleaned filters", async () => {
  const { db, calls } = fakeDb(() => ({ data: [] }));
  const res = await createHandler(() => db)(post({ action: "list", status: "open", ignored: "x" }));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { exams: [] });
  assert.equal(calls[0].name, "list_exams");
  assert.deepEqual(calls[0].args.p, { status: "open" });
});

Deno.test("get 404s a missing exam and rejects a bad id", async () => {
  const { db } = fakeDb(() => ({ data: null }));
  const h = createHandler(() => db);
  assert.equal((await h(post({ action: "get", id: EXAM }))).status, 404);
  assert.equal((await h(post({ action: "get", id: "nope" }))).status, 400);
});

Deno.test("set_status validates the status value and passes the actor", async () => {
  const { db, calls } = fakeDb(() => ({ data: null }));
  const h = createHandler(() => db);
  assert.deepEqual(await (await h(post({ action: "set_status", id: EXAM, status: "open" }))).json(), { ok: true });
  assert.equal(calls[0].name, "set_exam_status");
  assert.equal(calls[0].args.p_status, "open");
  assert.equal(calls[0].args.p_actor, TEACHER);
  assert.equal((await h(post({ action: "set_status", id: EXAM, status: "paused" }))).status, 400);
});

Deno.test("regenerate_code returns the new code", async () => {
  const { db, calls } = fakeDb(() => ({ data: "X9K2MD" }));
  const res = await createHandler(() => db)(post({ action: "regenerate_code", id: EXAM }));
  assert.deepEqual(await res.json(), { code: "X9K2MD" });
  assert.equal(calls[0].name, "regenerate_exam_code");
});

Deno.test("check_code normalizes the code before asking the database", async () => {
  const { db, calls } = fakeDb(() => ({ data: true }));
  const res = await createHandler(() => db)(post({ action: "check_code", code: " k7m2qx ", exclude_id: EXAM }));
  assert.deepEqual(await res.json(), { available: true });
  assert.equal(calls[0].args.p_code, "K7M2QX");
  assert.equal(calls[0].args.p_exclude, EXAM);
});

Deno.test("check_code refuses a malformed code without a database call", async () => {
  const { db, calls } = fakeDb();
  const res = await createHandler(() => db)(post({ action: "check_code", code: "AB!2" }));
  assert.equal(res.status, 400);
  assert.equal(calls.length, 0);
});

Deno.test("duplicate copies into a new draft", async () => {
  const { db, calls } = fakeDb(() => ({ data: "44444444-4444-4444-8444-444444444444" }));
  const res = await createHandler(() => db)(post({ action: "duplicate", id: EXAM }));
  assert.deepEqual(await res.json(), { id: "44444444-4444-4444-8444-444444444444" });
  assert.equal(calls[0].name, "duplicate_exam");
});

Deno.test("validation-hinted SQL errors become friendly 400s", async () => {
  const { db } = fakeDb(() => ({ error: { message: "The test code K7M2QX is already used by an open exam.", hint: "validation" } }));
  const res = await createHandler(() => db)(post(validExam));
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /already used/);
});

Deno.test("unexpected SQL errors stay hidden from the person", async () => {
  const { db } = fakeDb(() => ({ error: { message: "password authentication failed for user postgres" } }));
  const orig = console.error; console.error = () => {};
  const res = await createHandler(() => db)(post(validExam));
  console.error = orig;
  assert.equal(res.status, 500);
  assert.ok(!JSON.stringify(await res.json()).includes("password"));
});

Deno.test("requires a signed-in staff member; only POST is allowed", async () => {
  const { db, calls } = fakeDb();
  const h = createHandler(() => db);
  assert.equal((await h(post({ action: "list" }, null))).status, 401);
  assert.equal((await h(post({ action: "list" }, "bad"))).status, 401);
  assert.equal((await createHandler(() => fakeDb(() => ({}), null).db)(post({ action: "list" }))).status, 403);
  assert.equal((await h(new Request("http://x/", { method: "GET", headers: { authorization: "Bearer good" } }))).status, 405);
  assert.equal(calls.length, 0, "nothing reaches the database without access");
});

Deno.test("callRpc surfaces the validation hint", () => {
  const db = { rpc: () => Promise.resolve({ data: null, error: { message: "nope", hint: "validation" } }) };
  assert.rejects(() => callRpc(db, "x"), ApiError);
});
