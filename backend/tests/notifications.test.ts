import assert from "node:assert/strict";
import { createHandler, type Db } from "../functions/notifications/handler.ts";

const ME = "44444444-4444-4444-8444-444444444444";
const BELL = {
  kinds: { essays: [], suspicious: [], backup: null, accounts: [] },
  essays: 0, suspicious: 0, account: 0, backup: 0, total: 0, unread: 0, read_at: null,
};

/** A fake database, so every rule can be checked without a project. */
function fakeDb(opts: {
  role?: "teacher" | "admin" | null;
  rpc?: (name: string, args: Record<string, unknown>) => { data?: unknown; error?: { message: string; hint?: string | null; code?: string | null } };
} = {}) {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const role = opts.role === undefined ? "teacher" : opts.role;
  const db: Db = {
    auth: {
      getUser: (t: string) => Promise.resolve(t === "good" ? { data: { user: { id: ME } }, error: null } : { data: { user: null }, error: { message: "bad" } }),
    },
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () => Promise.resolve({ data: role ? { id: ME, full_name: "Ms. Rina", role, is_active: true } : null, error: null }),
        }),
      }),
    }),
    rpc: (name: string, args: Record<string, unknown> = {}) => {
      calls.push({ name, args });
      const r = opts.rpc?.(name, args) ?? { data: BELL };
      return Promise.resolve({ data: r.data ?? null, error: r.error ?? null });
    },
  };
  return { db, calls };
}

const post = (body: unknown, token: string | null = "good") =>
  new Request("http://x/", {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });

// ---------- who may call this at all ----------
Deno.test("the bell is for every signed-in staff member: a teacher's call reaches the database", async () => {
  const { db, calls } = fakeDb({ role: "teacher" });
  const res = await createHandler(() => db)(post({ action: "list" }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.notifications, BELL);
  assert.deepEqual(calls, [{ name: "list_notifications", args: { p_actor: ME, p_limit: 50 } }]);
});

Deno.test("an admin is allowed too", async () => {
  const { db, calls } = fakeDb({ role: "admin" });
  const res = await createHandler(() => db)(post({ action: "list" }));
  assert.equal(res.status, 200);
  assert.equal(calls[0].name, "list_notifications");
});

Deno.test("a deactivated account is refused and nothing is read", async () => {
  const { db, calls } = fakeDb({ role: null });
  const res = await createHandler(() => db)(post({ action: "list" }));
  assert.equal(res.status, 403);
  assert.equal(calls.length, 0);
});

Deno.test("a tokenless call is 401 and an unknown action is 400", async () => {
  const { db } = fakeDb();
  const h = createHandler(() => db);
  assert.equal((await h(post({ action: "list" }, null))).status, 401);
  assert.equal((await h(post({ action: "erase" }))).status, 400);
  assert.equal((await h(new Request("http://x/", { method: "GET", headers: { authorization: "Bearer good" } }))).status, 405);
});

// ---------- the two actions ----------
Deno.test("mark_read marks for the signed-in person and answers the repainted bell", async () => {
  const { db, calls } = fakeDb();
  const res = await createHandler(() => db)(post({ action: "mark_read" }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.notifications, BELL);
  assert.deepEqual(calls, [{ name: "mark_notifications_read", args: { p_actor: ME } }]);
});

Deno.test("the limit is validated before the database is asked", async () => {
  const { db, calls } = fakeDb();
  const h = createHandler(() => db);
  const res = await h(post({ action: "list", limit: 0 }));
  assert.equal(res.status, 400);
  assert.equal(calls.length, 0);
});

Deno.test("the actor always comes from the session, never from the browser", async () => {
  const { db, calls } = fakeDb();
  await createHandler(() => db)(post({ action: "list", actor: "11111111-1111-4111-8111-111111111111" }));
  assert.equal(calls[0].args.p_actor, ME);
  assert.equal("actor" in calls[0].args, false);
});

// ---------- the database's refusals pass through as friendly 400s ----------
Deno.test("a validation refusal from the function becomes a 400 with its words", async () => {
  const { db } = fakeDb({
    rpc: () => ({ error: { message: "This account has been deactivated.", hint: "validation", code: "P0001" } }),
  });
  const res = await createHandler(() => db)(post({ action: "list" }));
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /deactivated/);
});

Deno.test("an unexpected database failure is a logged 500, never its words", async () => {
  const { db } = fakeDb({ rpc: () => ({ error: { message: "connection refused", hint: null, code: "XX000" } }) });
  const res = await createHandler(() => db)(post({ action: "list" }));
  assert.equal(res.status, 500);
  const body = await res.json();
  assert.doesNotMatch(body.error, /connection refused/);
});
