import assert from "node:assert/strict";
import { createHandler, MAX_PASSWORD, MIN_PASSWORD, type Db } from "../functions/accounts/handler.ts";

const ADMIN = "22222222-2222-4222-8222-222222222222";
const NEW_ID = "33333333-3333-4333-8333-333333333333";
const EMAIL = "new.teacher@example.com";

interface Call { name: string; args: Record<string, unknown> }
interface AuthCall { fn: string; arg: unknown }

/** A fake database and a fake sign-in service, so every rule can be checked without a project. */
function fakeDb(opts: {
  role?: "teacher" | "admin" | null;
  rpc?: (name: string, args: Record<string, unknown>) => { data?: unknown; error?: { message: string; hint?: string; code?: string } };
  createUser?: { data: { user: { id: string } | null } | null; error: { message: string } | null };
  updateUser?: { data: unknown; error: { message: string } | null };
} = {}) {
  const calls: Call[] = [];
  const authCalls: AuthCall[] = [];
  const role = opts.role === undefined ? "admin" : opts.role;
  const db: Db = {
    auth: {
      getUser: (t: string) => Promise.resolve(t === "good" ? { data: { user: { id: ADMIN } }, error: null } : { data: { user: null }, error: { message: "bad" } }),
      admin: {
        createUser: (input) => {
          authCalls.push({ fn: "createUser", arg: input });
          return Promise.resolve(opts.createUser ?? { data: { user: { id: NEW_ID } }, error: null });
        },
        updateUserById: (id, input) => {
          authCalls.push({ fn: "updateUserById", arg: { id, ...input } });
          return Promise.resolve(opts.updateUser ?? { data: { user: { id } }, error: null });
        },
        deleteUser: (id) => {
          authCalls.push({ fn: "deleteUser", arg: id });
          return Promise.resolve({ error: null });
        },
      },
    },
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () => Promise.resolve({ data: role ? { id: ADMIN, full_name: "Admin", role, is_active: true } : null, error: null }),
        }),
      }),
    }),
    rpc: (name: string, args: Record<string, unknown> = {}) => {
      calls.push({ name, args });
      const r = opts.rpc?.(name, args) ?? { data: { ok: true } };
      return Promise.resolve({ data: r.data ?? null, error: r.error ?? null });
    },
  };
  return { db, calls, authCalls };
}

const post = (body: unknown, token: string | null = "good") =>
  new Request("http://x/", {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });

const createBody = { action: "create", email: EMAIL, full_name: "Ms. Rina", role: "teacher", password: "temporary-pass" };

// ---------- who may call this at all ----------
Deno.test("accounts are an admin job: a teacher gets 403 and nothing is created", async () => {
  const { db, calls, authCalls } = fakeDb({ role: "teacher" });
  const res = await createHandler(() => db)(post(createBody));
  assert.equal(res.status, 403);
  assert.equal(calls.length, 0);
  assert.equal(authCalls.length, 0);
});

Deno.test("a tokenless call is 401 and an unknown action is 400", async () => {
  const { db } = fakeDb();
  const h = createHandler(() => db);
  assert.equal((await h(post(createBody, null))).status, 401);
  assert.equal((await h(post({ action: "erase" }))).status, 400);
  assert.equal((await h(new Request("http://x/", { method: "GET", headers: { authorization: "Bearer good" } }))).status, 405);
});

// ---------- listing ----------
Deno.test("the list reads the accounts through the database function", async () => {
  const { db, calls } = fakeDb({ rpc: () => ({ data: { total: 1, rows: [{ id: ADMIN }] } }) });
  const res = await createHandler(() => db)(post({ action: "list" }));
  assert.deepEqual(await res.json(), { accounts: { total: 1, rows: [{ id: ADMIN }] } });
  assert.equal(calls[0].name, "list_accounts");
  assert.deepEqual(calls[0].args, {});
});

// ---------- creating ----------
Deno.test("creating an account confirms the login and then records the profile", async () => {
  const { db, calls, authCalls } = fakeDb();
  const res = await createHandler(() => db)(post({ ...createBody, email: `  ${EMAIL.toUpperCase()}  ` }));
  assert.equal(res.status, 200);
  assert.deepEqual(authCalls[0], {
    fn: "createUser",
    arg: { email: EMAIL, password: "temporary-pass", email_confirm: true, user_metadata: { full_name: "Ms. Rina" } },
  });
  assert.equal(calls[0].name, "record_account");
  assert.deepEqual(calls[0].args, { p_id: NEW_ID, p_email: EMAIL, p_full_name: "Ms. Rina", p_role: "teacher", p_actor: ADMIN });
});

Deno.test("person-fixable input problems are refused before anything is created", async () => {
  const { db, calls, authCalls } = fakeDb();
  const h = createHandler(() => db);
  const bad = [
    { ...createBody, email: "not-an-email" },
    { ...createBody, full_name: "  " },
    { ...createBody, role: "student" },
    { ...createBody, password: "short" },
    { ...createBody, password: "x".repeat(MAX_PASSWORD + 1) },
    { ...createBody, full_name: "<script>" },
  ];
  for (const body of bad) assert.equal((await h(post(body))).status, 400, JSON.stringify(body));
  assert.equal(calls.length + authCalls.length, 0);
  // and the shortest allowed password really is accepted (8 characters is the floor we tell people about)
  assert.equal((await h(post({ ...createBody, password: "x".repeat(MIN_PASSWORD) }))).status, 200);
});

Deno.test("an email that is already taken says so, in words a person can act on", async () => {
  const { db, calls } = fakeDb({ createUser: { data: { user: null }, error: { message: "A user with this email address has already been registered" } } });
  const res = await createHandler(() => db)(post(createBody));
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /already exists/);
  assert.equal(calls.length, 0, "no profile is written for a login that was not created");
});

Deno.test("a sign-in service problem is hidden from the person", async () => {
  const { db } = fakeDb({ createUser: { data: null, error: { message: "connection to auth service refused" } } });
  const orig = console.error; console.error = () => {};
  const res = await createHandler(() => db)(post(createBody));
  console.error = orig;
  assert.equal(res.status, 500);
  assert.ok(!JSON.stringify(await res.json()).includes("auth service"));
});

Deno.test("if the database refuses the profile, the fresh login is taken back out", async () => {
  const { db, authCalls } = fakeDb({ rpc: () => ({ error: { message: "Only an admin can manage accounts.", hint: "validation" } }) });
  const res = await createHandler(() => db)(post(createBody));
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /Only an admin/);
  assert.deepEqual(authCalls.map((c) => c.fn), ["createUser", "deleteUser"]);
  assert.equal(authCalls[1].arg, NEW_ID);
});

// ---------- updating ----------
Deno.test("renaming, changing a role and deactivating all go to the database function", async () => {
  const { db, calls } = fakeDb();
  const h = createHandler(() => db);
  await h(post({ action: "update", id: NEW_ID, full_name: "Ms. Rina Wijaya" }));
  assert.deepEqual(calls[0].args, { p_id: NEW_ID, p_full_name: "Ms. Rina Wijaya", p_role: null, p_is_active: null, p_actor: ADMIN });
  await h(post({ action: "update", id: NEW_ID, role: "admin" }));
  assert.deepEqual(calls[1].args, { p_id: NEW_ID, p_full_name: null, p_role: "admin", p_is_active: null, p_actor: ADMIN });
  await h(post({ action: "update", id: NEW_ID, is_active: false }));
  assert.deepEqual(calls[2].args, { p_id: NEW_ID, p_full_name: null, p_role: null, p_is_active: false, p_actor: ADMIN });
});

Deno.test("an update with nothing in it, a bad id or a bad role is refused before the database", async () => {
  const { db, calls } = fakeDb();
  const h = createHandler(() => db);
  assert.equal((await h(post({ action: "update", id: NEW_ID }))).status, 400);
  assert.equal((await h(post({ action: "update", id: "nope", full_name: "X" }))).status, 400);
  assert.equal((await h(post({ action: "update", id: NEW_ID, role: "student" }))).status, 400);
  assert.equal((await h(post({ action: "update", id: NEW_ID, is_active: "yes" }))).status, 400);
  assert.equal(calls.length, 0);
});

Deno.test("the database's own guards reach the person as a friendly refusal", async () => {
  const { db } = fakeDb({ rpc: () => ({ error: { message: "You cannot change your own role or deactivate your own account.", hint: "validation" } }) });
  const res = await createHandler(() => db)(post({ action: "update", id: ADMIN, role: "teacher" }));
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /your own role/);
});

// ---------- a new password ----------
Deno.test("setting a password changes it at the sign-in service and audits it without the password", async () => {
  const { db, calls, authCalls } = fakeDb();
  const res = await createHandler(() => db)(post({ action: "password", id: NEW_ID, password: "brand-new-pass" }));
  assert.equal(res.status, 200);
  assert.deepEqual(authCalls[0], { fn: "updateUserById", arg: { id: NEW_ID, password: "brand-new-pass" } });
  assert.equal(calls[0].name, "record_account_password");
  assert.deepEqual(calls[0].args, { p_id: NEW_ID, p_actor: ADMIN });
  assert.ok(!JSON.stringify(calls).includes("brand-new-pass"), "the password must never reach the database");
  assert.ok(!JSON.stringify(await res.json()).includes("brand-new-pass"));
});

Deno.test("a password that is too short is refused, and one that fails at the service is reported", async () => {
  const { db } = fakeDb();
  assert.equal((await createHandler(() => db)(post({ action: "password", id: NEW_ID, password: "short" }))).status, 400);
  const failing = fakeDb({ updateUser: { data: null, error: { message: "Password should be at least 6 characters" } } });
  const res = await createHandler(() => failing.db)(post({ action: "password", id: NEW_ID, password: "sixsixsix" }));
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /between 8 and 72/);
});
