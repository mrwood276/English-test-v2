import assert from "node:assert/strict";
import { createHandler, type Db } from "../functions/audit/handler.ts";
import { ApiError } from "../functions/_shared/errors.ts";

const TEACHER = "11111111-1111-4111-8111-111111111111";

interface Call { name: string; args: Record<string, unknown> }

// This endpoint is admin-only, so the fake database signs in as an admin unless a test says otherwise.
function fakeDb(
  rpcResult: (name: string, args: Record<string, unknown>) => { data?: unknown; error?: { message: string; hint?: string; code?: string } } = () => ({ data: { total: 0, rows: [] } }),
  role: "teacher" | "admin" | null = "admin",
) {
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

// ---------- handler ----------
Deno.test("the audit log is for admins: a teacher gets 403 and nothing reaches the database", async () => {
  const { db, calls } = fakeDb(() => ({}), "teacher");
  const res = await createHandler(() => db)(post({ action: "list" }));
  assert.equal(res.status, 403);
  assert.equal(calls.length, 0);
});

Deno.test("list defaults to 50 newest rows with no filters", async () => {
  const { db, calls } = fakeDb();
  const res = await createHandler(() => db)(post({ action: "list" }));
  assert.deepEqual(await res.json(), { logs: { total: 0, rows: [] } });
  assert.equal(calls[0].name, "list_audit_logs");
  assert.deepEqual(calls[0].args, { p_limit: 50, p_offset: 0, p_action: null, p_entity_type: null, p_days: null });
});

Deno.test("the filters reach the database", async () => {
  const { db, calls } = fakeDb();
  await createHandler(() => db)(post({ action: "list", limit: 25, offset: 50, filter_action: "grade", entity_type: "exam", days: 30 }));
  assert.deepEqual(calls[0].args, {
    p_limit: 25, p_offset: 50, p_action: "grade", p_entity_type: "exam", p_days: 30,
  });
});

Deno.test("person-fixable limits are refused before the database", async () => {
  const { db, calls } = fakeDb();
  const h = createHandler(() => db);
  assert.equal((await h(post({ action: "list", limit: 0 }))).status, 400);
  assert.equal((await h(post({ action: "list", limit: 201 }))).status, 400);
  assert.equal((await h(post({ action: "list", offset: -1 }))).status, 400);
  assert.equal((await h(post({ action: "list", days: 0 }))).status, 400);
  assert.equal((await h(post({ action: "list", filter_action: "" }))).status, 400);
  assert.equal(calls.length, 0);
});

Deno.test("an unknown action is refused", async () => {
  const { db, calls } = fakeDb();
  const h = createHandler(() => db);
  assert.equal((await h(post({ action: "erase_everything" }))).status, 400);
  assert.equal((await h(post({}))).status, 400);
  assert.equal(calls.length, 0);
});

Deno.test("a signed-in admin is required; only POST is allowed", async () => {
  const { db, calls } = fakeDb();
  const h = createHandler(() => db);
  assert.equal((await h(post({ action: "list" }, null))).status, 401);
  assert.equal((await h(post({ action: "list" }, "bad"))).status, 401);
  assert.equal((await createHandler(() => fakeDb(() => ({}), null).db)(post({ action: "list" }))).status, 403);
  assert.equal((await h(new Request("http://x/", { method: "GET", headers: { authorization: "Bearer good" } }))).status, 405);
  assert.equal(calls.length, 0, "nothing reaches the database without access");
});

Deno.test("validation-hinted SQL errors become friendly 400s", async () => {
  const { db } = fakeDb(() => ({ error: { message: "Limit must be between 1 and 200.", hint: "validation" } }));
  const res = await createHandler(() => db)(post({ action: "list", limit: 0 }));
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /between 1 and 200/);
});

Deno.test("unexpected SQL errors stay hidden from the person", async () => {
  const { db } = fakeDb(() => ({ error: { message: "password authentication failed for user postgres" } }));
  const orig = console.error; console.error = () => {};
  const res = await createHandler(() => db)(post({ action: "list" }));
  console.error = orig;
  assert.equal(res.status, 500);
  assert.ok(!JSON.stringify(await res.json()).includes("password"));
});
