import assert from "node:assert/strict";
import { createHandler, type Db } from "../functions/session/handler.ts";
import { parseAnswers, parseEventMeta, parseEventType, parseJoin, parseReason } from "../functions/session/parse.ts";
import { signSessionToken, verifySessionToken } from "../functions/session/token.ts";
import { ApiError } from "../functions/_shared/errors.ts";

const SESSION = "44444444-4444-4444-8444-444444444444";
const OTHER = "55555555-5555-4555-8555-555555555555";
const QUESTION = "33333333-3333-4333-8333-333333333331";
const SECRET = "test-secret";
const TOKEN = await signSessionToken(SESSION, SECRET);

interface Call { name: string; args: Record<string, unknown> }
type Result = { data?: unknown; error?: { message: string; hint?: string; code?: string } };

function fakeDb(rpcResult: (name: string, args: Record<string, unknown>) => Result = () => ({ data: null })) {
  const calls: Call[] = [];
  const signed: { paths: string[]; expiresIn: number }[] = [];
  const db: Db = {
    rpc: (name: string, args: Record<string, unknown> = {}) => {
      calls.push({ name, args });
      if (name === "rate_limit_hit" && rpcResult(name, args).data === undefined) return Promise.resolve({ data: 1, error: null });
      const r = rpcResult(name, args);
      return Promise.resolve({ data: r.data ?? null, error: r.error ?? null });
    },
    storage: {
      from: () => ({
        createSignedUrls: (paths: string[], expiresIn: number) => {
          signed.push({ paths, expiresIn });
          return Promise.resolve({ data: paths.map((p) => ({ path: p, signedUrl: `https://signed/${p}`, error: null })), error: null });
        },
      }),
    },
  };
  return { db, calls, signed };
}

const post = (body: unknown) =>
  new Request("http://x/", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const handler = (db: Db) => createHandler(() => db, { secret: SECRET });
const rpcNames = (calls: Call[]) => calls.filter((c) => c.name !== "rate_limit_hit").map((c) => c.name);
const rpcCall = (calls: Call[], name: string): Call => {
  const found = calls.find((c) => c.name === name);
  if (!found) throw new Error(`no ${name} call was recorded`);
  return found;
};

// ---------- parsing ----------
Deno.test("parseJoin tidies the code students type", () => {
  assert.deepEqual(parseJoin({ code: " k7m 2qx ", name: "Aisyah Putri", class: "XII TKJ A" }), {
    code: "K7M2QX",
    name: "Aisyah Putri",
    class: "XII TKJ A",
  });
});

Deno.test("parseJoin refuses a short name, a missing class, and markup", () => {
  const ok = { code: "K7M2QX", name: "Bima", class: "X TKJ A" };
  assert.throws(() => parseJoin({ ...ok, name: "B" }), (e: unknown) => e instanceof ApiError && /Full name/.test(e.message));
  assert.throws(() => parseJoin({ ...ok, class: "" }), (e: unknown) => e instanceof ApiError && /Class/.test(e.message));
  assert.throws(() => parseJoin({ ...ok, name: "<script>x</script>" }), (e: unknown) => e instanceof ApiError && /cannot contain/.test(e.message));
  assert.throws(() => parseJoin({ ...ok, code: "ab" }), (e: unknown) => e instanceof ApiError && /4 to 12 letters and digits/.test(e.message));
  assert.throws(() => parseJoin({ ...ok, code: "ab!2" }), (e: unknown) => e instanceof ApiError && /4 to 12 letters and digits/.test(e.message));
});

Deno.test("parseAnswers shapes one answer per question", () => {
  const answers = parseAnswers({
    answers: [
      { question_id: QUESTION, answer: { text: "B" }, is_flagged: true },
      { question_id: SESSION, answer: { text: "" } },
      { question_id: OTHER, answer: { text: "essay body" }, client_saved_at: "2026-09-23T10:00:00Z" },
    ],
  });
  assert.equal(answers.length, 3);
  assert.deepEqual(answers[0], { question_id: QUESTION, answer: { text: "B" }, is_flagged: true });
  assert.deepEqual(answers[1], { question_id: SESSION, answer: { text: "" }, is_flagged: false });
  assert.equal(answers[2].client_saved_at, "2026-09-23T10:00:00.000Z");
});

Deno.test("parseAnswers treats a missing answer as an empty one and refuses junk", () => {
  assert.deepEqual(parseAnswers({ answers: [{ question_id: QUESTION }] }), [
    { question_id: QUESTION, answer: { text: "" }, is_flagged: false },
  ]);
  assert.throws(() => parseAnswers({ answers: [{ question_id: "nope" }] }), (e: unknown) => e instanceof ApiError && /valid id/.test(e.message));
  assert.throws(() => parseAnswers({ answers: [{ question_id: QUESTION, client_saved_at: "yesterday" }] }), (e: unknown) => e instanceof ApiError && /invalid save time/.test(e.message));
  assert.throws(() => parseAnswers({ answers: "nope" }), (e: unknown) => e instanceof ApiError && /must be a list/.test(e.message));
});

Deno.test("parseEventMeta keeps small, known-shaped details", () => {
  assert.deepEqual(parseEventMeta(undefined), {});
  assert.deepEqual(parseEventMeta({ hidden_seconds: 12, online: false, note: "lost" }), { hidden_seconds: 12, online: false, note: "lost" });
  assert.throws(() => parseEventMeta({ "Bad Key": 1 }), (e: unknown) => e instanceof ApiError && /not allowed/.test(e.message));
  assert.throws(() => parseEventMeta({ ok: { nested: true } }), (e: unknown) => e instanceof ApiError && /not allowed/.test(e.message));
});

Deno.test("event types and submit reasons are closed lists", () => {
  assert.equal(parseEventType("tab_hidden"), "tab_hidden");
  assert.throws(() => parseEventType("sneaky"), ApiError);
  assert.equal(parseReason("time_up"), "time_up");
  assert.throws(() => parseReason("whatever"), ApiError);
});

// ---------- the session token ----------
Deno.test("a session token round-trips and is tied to its session", async () => {
  assert.equal(await verifySessionToken(TOKEN, SECRET), SESSION);
  const other = await signSessionToken(OTHER, SECRET);
  assert.equal(await verifySessionToken(other, SECRET), OTHER);
  assert.notEqual(TOKEN, other);
});

Deno.test("a forged or foreign token is refused", async () => {
  assert.equal(await verifySessionToken(TOKEN, "another-secret"), null, "wrong key");
  assert.equal(await verifySessionToken(`${SESSION}.AAAA`, SECRET), null, "wrong signature");
  assert.equal(await verifySessionToken(OTHER.slice(0, 36) + "." + TOKEN.split(".")[1], SECRET), null, "signature of a different session");
  assert.equal(await verifySessionToken("no-dots-here", SECRET), null);
  assert.equal(await verifySessionToken("not-a-uuid.AAAA", SECRET), null);
});

// ---------- handler ----------
Deno.test("join rate limits the address, then calls exam_join and hands out a token", async () => {
  const { db, calls } = fakeDb((name) => name === "exam_join" ? { data: { session: { id: SESSION, status: "in_progress" }, questions: [{ position: 1 }], answers: [] } } : { data: null });
  const res = await handler(db)(post({ action: "join", code: "k7m2qx", name: "Aisyah Putri", class: "XII TKJ A" }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.questions, [{ position: 1 }]);
  assert.equal(await verifySessionToken(body.token, SECRET), SESSION, "the token opens this session");
  assert.equal(calls[0].name, "rate_limit_hit");
  assert.equal(calls[0].args.p_bucket, "session_join");
  assert.equal(calls[1].name, "exam_join");
  assert.deepEqual(calls[1].args.p, { code: "K7M2QX", name: "Aisyah Putri", class: "XII TKJ A" });
});

Deno.test("join passes a friendly validation message through as 400", async () => {
  const { db } = fakeDb((name) => name === "exam_join" ? { error: { message: "That test code was not found. Check the code on the board.", hint: "validation" } } : { data: null });
  const res = await handler(db)(post({ action: "join", code: "ZZZZZZ", name: "Bima", class: "X TKJ A" }));
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /code was not found/);
});

Deno.test("a busy network address is turned away with 429", async () => {
  const { db } = fakeDb(() => ({ data: 999 }));
  const res = await handler(db)(post({ action: "join", code: "K7M2QX", name: "Bima", class: "X TKJ A" }));
  assert.equal(res.status, 429);
  assert.equal(res.headers.get("Retry-After"), "60");
});

Deno.test("every other action needs a real session token", async () => {
  const { db, calls } = fakeDb(() => ({ data: {} }));
  const h = handler(db);
  for (const action of ["get", "save", "heartbeat", "event", "submit", "result", "media"]) {
    assert.equal((await h(post({ action }))).status, 400, `${action} without a token is refused`);
  }
  assert.equal((await h(post({ action: "get", token: `${SESSION}.AAAA` }))).status, 401, "a forged token is refused");
  assert.equal((await h(post({ action: "get", token: await signSessionToken(SESSION, "other-key") }))).status, 401, "a token signed elsewhere is refused");
  assert.deepEqual(rpcNames(calls), [], "no database work happened for a refused caller");
});

Deno.test("get returns the session for a valid token", async () => {
  const { db, calls } = fakeDb((name) => name === "get_exam_session" ? { data: { session: { id: SESSION, status: "in_progress" }, questions: [], answers: [] } } : { data: null });
  const res = await handler(db)(post({ action: "get", token: TOKEN }));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).session.status, "in_progress");
  assert.equal(calls[calls.length - 1].name, "get_exam_session");
  assert.deepEqual(calls[calls.length - 1].args, { p_id: SESSION });
});

Deno.test("save limits per session (shared networks are safe) and sends parsed answers", async () => {
  const { db, calls } = fakeDb((name) => name === "save_session_answers" ? { data: { accepted: true, saved: 1 } } : { data: null });
  const res = await handler(db)(post({ action: "save", token: TOKEN, answers: [{ question_id: QUESTION, answer: { text: "B" }, is_flagged: true }] }));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { accepted: true, saved: 1 });
  const limited = rpcCall(calls, "rate_limit_hit");
  assert.equal(limited.args.p_bucket, "session_save");
  assert.equal(limited.args.p_key, SESSION, "the limit follows the session, not the address");
  const save = rpcCall(calls, "save_session_answers");
  assert.equal(save.args.p_id, SESSION);
  assert.deepEqual(save.args.p_answers, [{ question_id: QUESTION, answer: { text: "B" }, is_flagged: true }]);
});

Deno.test("save refuses a body that is too large", async () => {
  const { db } = fakeDb(() => ({ data: null }));
  const big = { action: "save", token: TOKEN, answers: Array.from({ length: 201 }, () => ({ question_id: QUESTION, answer: { text: "x" } })) };
  assert.equal((await handler(db)(post(big))).status, 400);
});

Deno.test("submit defaults to the student reason and accepts the automatic ones", async () => {
  const { db, calls } = fakeDb((name) => name === "submit_exam_session" ? { data: { submitted: true } } : { data: null });
  const h = handler(db);
  await h(post({ action: "submit", token: TOKEN }));
  assert.equal(calls[calls.length - 1].args.p_reason, "student");
  await h(post({ action: "submit", token: TOKEN, reason: "tab_switch_limit" }));
  assert.equal(calls[calls.length - 1].args.p_reason, "tab_switch_limit");
  assert.equal((await h(post({ action: "submit", token: TOKEN, reason: "cheat" }))).status, 400);
});

Deno.test("event logs the type and its small details", async () => {
  const { db, calls } = fakeDb((name) => name === "log_session_event" ? { data: { autosubmit: false, tab_switch_count: 1 } } : { data: null });
  const res = await handler(db)(post({ action: "event", token: TOKEN, event_type: "tab_hidden", meta: { hidden_seconds: 4 } }));
  assert.equal((await res.json()).tab_switch_count, 1);
  const call = rpcCall(calls, "log_session_event");
  assert.equal(call.args.p_event_type, "tab_hidden");
  assert.deepEqual(call.args.p_meta, { hidden_seconds: 4 });
  assert.equal((await handler(db)(post({ action: "event", token: TOKEN, event_type: "sneaky" }))).status, 400);
});

Deno.test("media signs only the files this session is allowed to show", async () => {
  const { db, calls, signed } = fakeDb((name) => {
    if (name === "get_session_media_ids") return { data: ["m1"] };
    if (name === "get_media_paths") return { data: [{ id: "m1", path: "audio/2026/x.mp3" }] };
    return { data: null };
  });
  const res = await handler(db)(post({ action: "media", token: TOKEN }));
  assert.deepEqual(await res.json(), { urls: { m1: "https://signed/audio/2026/x.mp3" }, expires_in: 3600 });
  assert.deepEqual(signed[0], { paths: ["audio/2026/x.mp3"], expiresIn: 3600 });
  assert.deepEqual(rpcCall(calls, "get_session_media_ids").args, { p_id: SESSION });
});

Deno.test("media asks Storage for nothing when the session has no files", async () => {
  const { db, calls, signed } = fakeDb((name) => name === "get_session_media_ids" ? { data: [] } : { data: null });
  const res = await handler(db)(post({ action: "media", token: TOKEN }));
  assert.deepEqual(await res.json(), { urls: {}, expires_in: 3600 });
  assert.equal(signed.length, 0);
  assert.deepEqual(rpcNames(calls), ["get_session_media_ids"]);
});

Deno.test("an unknown action is refused before any work", async () => {
  const { db, calls } = fakeDb(() => ({ data: null }));
  assert.equal((await handler(db)(post({ action: "cheat", token: TOKEN }))).status, 400);
  assert.deepEqual(calls, []);
});

Deno.test("only POST is allowed", async () => {
  const { db } = fakeDb(() => ({ data: null }));
  const res = await handler(db)(new Request("http://x/", { method: "GET" }));
  assert.equal(res.status, 405);
});
