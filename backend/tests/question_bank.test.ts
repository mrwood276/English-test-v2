import assert from "node:assert/strict";
import { createHandler, type Db } from "../functions/question-bank/handler.ts";
import { parseListFilters, parseQuestionInput, parsePassageInput } from "../functions/question-bank/parse.ts";
import { asNumber, asPlain } from "../functions/_shared/validate.ts";
import { callRpc } from "../functions/_shared/rpc.ts";
import { ApiError } from "../functions/_shared/errors.ts";

const TEACHER = "11111111-1111-4111-8111-111111111111";
const QID = "22222222-2222-4222-8222-222222222222";

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

const validQuestion = {
  action: "save", type: "multiple_choice", difficulty: "hots", topic: "Narrative Text", body: "What did <b>Dina</b> do first?", weight: 2,
  class_labels: ["XII TKJ A", "  ", "XII TKJ B"],
  options: [{ body: "She kept the money.", is_correct: false }, { body: "She looked around.", is_correct: true }],
};

// ---------- parsing ----------
Deno.test("parseQuestionInput cleans and shapes a multiple choice question", () => {
  const { id, payload } = parseQuestionInput(validQuestion);
  assert.equal(id, undefined);
  assert.equal(payload.type, "multiple_choice");
  assert.equal(payload.body, "What did <b>Dina</b> do first?");
  assert.deepEqual(payload.class_labels, ["XII TKJ A", "XII TKJ B"], "blank labels are dropped");
  assert.equal(payload.weight, 2);
  assert.equal(payload.passage_id, null);
  assert.deepEqual(payload.accepted_answers, []);
  assert.equal((payload.options as unknown[]).length, 2);
});

Deno.test("parseQuestionInput removes dangerous markup and keeps simple formatting", () => {
  const { payload } = parseQuestionInput({
    ...validQuestion,
    body: 'Fix <u>this</u><script>alert(1)</script> <img src=x onerror=alert(2)>',
    explanation: '<a href="javascript:alert(3)">click</a> <i>because</i>',
    options: [{ body: "<b onclick=x()>Yes</b>", is_correct: true }, { body: "No", is_correct: false }],
  });
  assert.equal(payload.body, "Fix <u>this</u> ");
  assert.equal(payload.explanation, "click <i>because</i>");
  assert.equal((payload.options as { body: string }[])[0].body, "<b>Yes</b>");
});

Deno.test("parseQuestionInput refuses bad input with friendly messages", () => {
  const refuses = (over: Record<string, unknown>, msg: RegExp) => assert.throws(() => parseQuestionInput({ ...validQuestion, ...over }), (e: ApiError) => e.status === 400 && msg.test(e.message));
  refuses({ type: "nope" }, /Question type/);
  refuses({ body: "   " }, /question is required/);
  refuses({ difficulty: "hard" }, /Difficulty/);
  refuses({ weight: 0 }, /Points/);
  refuses({ weight: "3" }, /Points must be a number/);
  refuses({ options: new Array(7).fill({ body: "x", is_correct: false }) }, /at most 6/);
  refuses({ options: [{ body: "", is_correct: true }] }, /Answer 1/);
  refuses({ options: ["text"] }, /Answer 1 must be an object/);
  refuses({ class_labels: ["<script>"] }, /cannot contain/);
  refuses({ class_labels: new Array(11).fill("A") }, /at most 10/);
  refuses({ topic: "a<b" }, /Topic cannot contain/);
  refuses({ passage_id: "nope" }, /not a valid id/);
  refuses({ id: "nope" }, /not a valid id/);
});

Deno.test("parseQuestionInput handles the other question types", () => {
  const sa = parseQuestionInput({ action: "save", type: "short_answer", body: "The ____ tense", accepted_answers: ["past", "Simple Past"] });
  assert.deepEqual(sa.payload.accepted_answers, ["past", "Simple Past"]);
  assert.equal(sa.payload.difficulty, "medium");
  const essay = parseQuestionInput({ action: "save", type: "essay", body: "Explain.", essay_guidance: "One mark per idea.", weight: 4, id: QID });
  assert.equal(essay.id, QID);
  assert.equal(essay.payload.essay_guidance, "One mark per idea.");
});

Deno.test("parseListFilters only passes valid filters", () => {
  assert.deepEqual(parseListFilters({ action: "list" }), {});
  assert.deepEqual(parseListFilters({ q: "wallet", topic: "", difficulty: "hots", type: "essay", class_label: "XII TKJ A", archived: false, used: "unused", sort: "body", page: 2, page_size: 50 }),
    { q: "wallet", difficulty: "hots", type: "essay", class_label: "XII TKJ A", archived: false, used: "unused", sort: "body", page: 2, page_size: 50 });
  assert.throws(() => parseListFilters({ difficulty: "hard" }), /Difficulty/);
  assert.throws(() => parseListFilters({ page_size: 1000 }), /between 1 and 100/);
  assert.throws(() => parseListFilters({ sort: "random" }), /Sort/);
});

Deno.test("parsePassageInput", () => {
  const { payload } = parsePassageInput({ title: "The Lost Wallet", body: "Dina found a <u>wallet</u><script>x</script>." });
  assert.deepEqual(payload, { title: "The Lost Wallet", body: "Dina found a <u>wallet</u>." });
  assert.throws(() => parsePassageInput({ title: "", body: "x" }), /Title is required/);
});

Deno.test("asNumber and asPlain", () => {
  assert.equal(asNumber(1.5, "Points", { min: 0.01, max: 100 }), 1.5);
  assert.throws(() => asNumber(NaN, "Points", { min: 0, max: 1 }), /must be a number/);
  assert.equal(asPlain("XII TKJ A", "Label", { max: 40 }), "XII TKJ A");
  assert.throws(() => asPlain("a>b", "Label", { max: 40 }), /cannot contain/);
});

// ---------- rpc helper ----------
Deno.test("callRpc turns validation problems into 400 and hides other failures", async () => {
  const ok = await callRpc({ rpc: () => Promise.resolve({ data: { a: 1 }, error: null }) }, "x");
  assert.deepEqual(ok, { a: 1 });
  await assert.rejects(() => callRpc({ rpc: () => Promise.resolve({ data: null, error: { message: "Choose exactly one correct answer.", hint: "validation" } }) }, "x"), (e: ApiError) => e.status === 400 && e.message === "Choose exactly one correct answer.");
  await assert.rejects(() => callRpc({ rpc: () => Promise.resolve({ data: null, error: { message: "bad uuid", code: "22P02" } }) }, "x"), (e: ApiError) => e.status === 400);
  await assert.rejects(() => callRpc({ rpc: () => Promise.resolve({ data: null, error: { message: "connection refused" } }) }, "x"), (e: Error) => !(e instanceof ApiError) && /rpc x failed/.test(e.message));
});

// ---------- the endpoint ----------
Deno.test("the endpoint requires a signed-in teacher or admin", async () => {
  const { db, calls } = fakeDb();
  const h = createHandler(() => db);
  assert.equal((await h(post({ action: "list" }, null))).status, 401);
  assert.equal((await h(post({ action: "list" }, "bad"))).status, 401);
  assert.equal((await createHandler(() => fakeDb(() => ({}), null).db)(post({ action: "list" }))).status, 403);
  assert.equal((await h(new Request("http://x/", { method: "GET", headers: { authorization: "Bearer good" } }))).status, 405);
  assert.equal(calls.length, 0, "nothing reaches the database without access");
});

Deno.test("list passes cleaned filters to the database and returns the result", async () => {
  const { db, calls } = fakeDb(() => ({ data: { items: [], total: 0, page: 1, page_size: 25 } }));
  const res = await createHandler(() => db)(post({ action: "list", q: "wallet", difficulty: "hots", ignored: "x" }));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { items: [], total: 0, page: 1, page_size: 25 });
  assert.deepEqual(calls[0], { name: "list_questions", args: { p: { q: "wallet", difficulty: "hots" } } });
});

Deno.test("save sends the sanitized question with the signed-in person as actor", async () => {
  const { db, calls } = fakeDb(() => ({ data: QID }));
  const res = await createHandler(() => db)(post({ ...validQuestion, body: "Q <script>x</script>text" }));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { id: QID });
  assert.equal(calls[0].name, "save_question");
  assert.equal(calls[0].args.p_actor, TEACHER);
  assert.equal(calls[0].args.p_id, null);
  assert.equal((calls[0].args.p as { body: string }).body, "Q text");
});

Deno.test("save shows database validation messages as friendly 400 errors", async () => {
  const { db } = fakeDb(() => ({ error: { message: "Choose exactly one correct answer.", hint: "validation" } }));
  const res = await createHandler(() => db)(post(validQuestion));
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, "Choose exactly one correct answer.");
});

Deno.test("unexpected database errors are hidden from the person", async () => {
  const { db } = fakeDb(() => ({ error: { message: "password authentication failed for user postgres" } }));
  const orig = console.error; console.error = () => {};
  const res = await createHandler(() => db)(post({ action: "topics" }));
  console.error = orig;
  assert.equal(res.status, 500);
  assert.ok(!JSON.stringify(await res.json()).includes("password"));
});

Deno.test("get, remove, archive, duplicates, topics, labels, and passages", async () => {
  const { db, calls } = fakeDb((name) => {
    if (name === "get_question") return { data: null };
    if (name === "remove_question") return { data: "archived" };
    return { data: [] };
  });
  const h = createHandler(() => db);
  assert.equal((await h(post({ action: "get", id: QID }))).status, 404);
  assert.equal((await h(post({ action: "get", id: "nope" }))).status, 400);
  assert.deepEqual(await (await h(post({ action: "remove", id: QID }))).json(), { result: "archived" });
  assert.deepEqual(await (await h(post({ action: "archive", id: QID }))).json(), { ok: true });
  assert.deepEqual(calls.at(-1), { name: "set_question_archived", args: { p_id: QID, p_archived: true, p_actor: TEACHER } });
  await h(post({ action: "restore", id: QID }));
  assert.equal(calls.at(-1)!.args.p_archived, false);
  await h(post({ action: "check_duplicates", body: "What <script>x</script>is it?", options: ["A", "<b>B</b>"], exclude_id: QID }));
  assert.deepEqual(calls.at(-1), { name: "find_similar_questions", args: { p_body: "What is it?", p_options: ["A", "<b>B</b>"], p_exclude: QID, p_threshold: 0.55 } });
  await h(post({ action: "class_labels", prefix: "xii" }));
  assert.deepEqual(calls.at(-1), { name: "list_class_labels", args: { p_prefix: "xii" } });
  await h(post({ action: "topics" }));
  await h(post({ action: "passages", q: "wallet" }));
  assert.deepEqual(calls.at(-1), { name: "list_passages", args: { p_q: "wallet" } });
  assert.equal((await h(post({ action: "passage_get", id: QID }))).status, 200);
  await h(post({ action: "passage_save", title: "T", body: "B" }));
  assert.equal(calls.at(-1)!.name, "save_passage");
  await h(post({ action: "passage_remove", id: QID }));
  assert.equal(calls.at(-1)!.name, "remove_passage");
});

Deno.test("duplicate_groups asks the database for the overview scan, with no arguments", async () => {
  // The scan runs with the SQL defaults (threshold 0.55, at most 50 pairs); the screen sends no filters.
  const payload = { question_count: 3, exact_groups: [{ kind: "exact", questions: [{ id: QID, body: "Same text", used_in_exams: 0 }] }], similar_pairs: [] };
  const { db, calls } = fakeDb((name) => (name === "find_duplicate_groups" ? { data: payload } : {}));
  const res = await createHandler(() => db)(post({ action: "duplicate_groups" }));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), payload);
  assert.deepEqual(calls, [{ name: "find_duplicate_groups", args: {} }]);
});

Deno.test("duplicate_groups is available to a teacher as well as to an admin", async () => {
  for (const role of ["teacher", "admin"] as const) {
    const { db, calls } = fakeDb(() => ({ data: { question_count: 0, exact_groups: [], similar_pairs: [] } }), role);
    assert.equal((await createHandler(() => db)(post({ action: "duplicate_groups" }))).status, 200, role);
    assert.equal(calls[0].name, "find_duplicate_groups");
  }
});

Deno.test("unknown actions and malformed bodies are refused", async () => {
  const { db, calls } = fakeDb();
  const h = createHandler(() => db);
  assert.equal((await h(post({ action: "drop_everything" }))).status, 400);
  assert.equal((await h(post({}))).status, 400);
  assert.equal((await h(post([1, 2]))).status, 400);
  assert.equal((await h(new Request("http://x/", { method: "POST", headers: { authorization: "Bearer good" }, body: "{bad" }))).status, 400);
  assert.equal(calls.length, 0);
});

// ---------- import ----------
import { parseImportItems, parseImportCheckItems } from "../functions/question-bank/parse.ts";

const importRow = { row: 4, type: "multiple_choice", body: "Who <b>found</b> it?<script>x</script>", difficulty: "easy", options: [{ body: "Dina", is_correct: true }, { body: "Budi", is_correct: false }], class_labels: ["XII TKJ A"] };

Deno.test("parseImportItems cleans each question and keeps its row number", () => {
  const [item] = parseImportItems([importRow]);
  assert.equal(item.row, 4);
  assert.equal(item.body, "Who <b>found</b> it?");
  assert.equal(item.type, "multiple_choice");
  assert.deepEqual(item.class_labels, ["XII TKJ A"]);
  assert.equal("media" in item, false, "files cannot be imported");
  assert.equal("id" in item, false);
});

Deno.test("parseImportItems handles reading texts by title", () => {
  const items = parseImportItems([
    { ...importRow, passage: { title: "The Lost Wallet", body: "Dina <u>found</u> a wallet.<script>x</script>" } },
    { ...importRow, row: 5, passage: { title: "The Lost Wallet" } },
  ]);
  assert.deepEqual(items[0].passage, { title: "The Lost Wallet", body: "Dina <u>found</u> a wallet." });
  assert.deepEqual(items[1].passage, { title: "The Lost Wallet" }, "a title alone links to an existing text");
  assert.equal(items[0].passage_id, null);
  assert.throws(() => parseImportItems([{ ...importRow, passage: { title: "" } }]), /Row 4: .*title/);
});

Deno.test("parseImportItems names the row of a problem and limits the batch", () => {
  assert.throws(() => parseImportItems([importRow, { ...importRow, row: 9, difficulty: "hard" }]), (e: ApiError) => e.status === 400 && /^Row 9: Difficulty/.test(e.message));
  assert.throws(() => parseImportItems([{ ...importRow, body: "   " }]), (e: ApiError) => e.message === "Row 4: The question is required.");
  assert.throws(() => parseImportItems([]), /needs at least 1/);
  assert.throws(() => parseImportItems(new Array(201).fill(importRow)), /at most 200/);
  assert.throws(() => parseImportItems(["text"]), /must be an object/);
  assert.equal(parseImportItems([{ ...importRow, row: undefined }, { ...importRow, row: undefined }])[1].row, 2, "rows without a number use their position");
});

Deno.test("parseImportCheckItems keeps only what the duplicate check needs", () => {
  const [a] = parseImportCheckItems([{ i: 7, body: "Q <script>x</script>text", options: ["<b>A</b>", " B "], extra: "ignored" }]);
  assert.deepEqual(a, { i: 7, body: "Q text", options: ["<b>A</b>", "B"] });
  assert.throws(() => parseImportCheckItems([{ body: "" }]), /required/);
});

Deno.test("the import endpoints check first and save all-or-nothing", async () => {
  const { db, calls } = fakeDb((name) => (name === "find_similar_batch" ? { data: [{ i: 0, matches: [] }] } : { data: { created: 1, passages_created: 0, ids: [QID] } }));
  const h = createHandler(() => db);
  const chk = await h(post({ action: "import_check", items: [{ body: "Who found it?", options: ["Dina", "Budi"] }] }));
  assert.equal(chk.status, 200);
  assert.deepEqual(await chk.json(), { results: [{ i: 0, matches: [] }] });
  assert.equal(calls.at(-1)!.name, "find_similar_batch");
  const imp = await h(post({ action: "import", items: [importRow] }));
  assert.equal(imp.status, 200);
  assert.equal((await imp.json()).created, 1);
  assert.equal(calls.at(-1)!.name, "import_questions");
  assert.equal(calls.at(-1)!.args.p_actor, TEACHER);
  assert.equal((calls.at(-1)!.args.p_items as { row: number }[])[0].row, 4);
  const bad = await h(post({ action: "import", items: [{ ...importRow, difficulty: "nope" }] }));
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /^Row 4:/);
  const dbErr = createHandler(() => fakeDb(() => ({ error: { message: "Row 7: Choose exactly one correct answer.", hint: "validation" } })).db);
  const refused = await dbErr(post({ action: "import", items: [importRow] }));
  assert.equal(refused.status, 400);
  assert.equal((await refused.json()).error, "Row 7: Choose exactly one correct answer.");
});
