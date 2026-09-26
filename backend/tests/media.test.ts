import assert from "node:assert/strict";
import { createHandler, type Db, type StorageBucket, IMAGE_MAX_BYTES, AUDIO_MAX_BYTES } from "../functions/media/handler.ts";
import { parseQuestionInput, parsePassageInput } from "../functions/question-bank/parse.ts";

const TEACHER = "11111111-1111-4111-8111-111111111111";
const M1 = "33333333-3333-4333-8333-333333333333";
const M2 = "44444444-4444-4444-8444-444444444444";

function fake(opts: { role?: "teacher" | "admin"; objects?: Record<string, { size?: number; mimetype?: string }>; rpc?: (n: string, a: Record<string, unknown>) => { data?: unknown; error?: { message: string; hint?: string } } } = {}) {
  const removed: string[][] = [];
  const signed: string[][] = [];
  const rpcCalls: { name: string; args: Record<string, unknown> }[] = [];
  const bucket: StorageBucket = {
    createSignedUploadUrl: (path) => Promise.resolve({ data: { signedUrl: `https://storage.test/upload/${path}?token=t`, token: "t", path }, error: null }),
    list: (dir, o) => Promise.resolve({ data: Object.entries(opts.objects ?? {}).filter(([p]) => p.startsWith(dir + "/") && p.endsWith(o.search)).map(([p, meta]) => ({ name: p.split("/").pop()!, metadata: meta })), error: null }),
    remove: (paths) => { removed.push(paths); return Promise.resolve({ error: null }); },
    createSignedUrls: (paths) => { signed.push(paths); return Promise.resolve({ data: paths.map((p) => ({ path: p, signedUrl: `https://storage.test/view/${p}?sig=1`, error: null })), error: null }); },
  };
  const db: Db = {
    auth: { getUser: (t: string) => Promise.resolve(t === "good" ? { data: { user: { id: TEACHER } }, error: null } : { data: { user: null }, error: { message: "bad" } }) },
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: { id: TEACHER, full_name: "Ms. Rina", role: opts.role ?? "teacher", is_active: true }, error: null }) }) }) }),
    rpc: (name: string, args: Record<string, unknown> = {}) => {
      rpcCalls.push({ name, args });
      const r = opts.rpc ? opts.rpc(name, args) : { data: null };
      return Promise.resolve({ data: r.data ?? null, error: r.error ?? null });
    },
    storage: { from: (b: string) => { assert.equal(b, "question-media"); return bucket; } },
  };
  return { db, removed, signed, rpcCalls };
}
const post = (body: unknown, token: string | null = "good") =>
  new Request("http://x/", { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });

Deno.test("create_upload gives a one-time link and a random path that fits the file type", async () => {
  const { db } = fake();
  const h = createHandler(() => db);
  const res = await h(post({ action: "create_upload", mime_type: "image/webp", size_bytes: 400_000, name: "wallet.webp" }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.match(body.path, /^image\/\d{4}\/[0-9a-f-]{36}\.webp$/);
  assert.ok(body.upload_url.includes(body.path));
  assert.equal(body.max_bytes, IMAGE_MAX_BYTES);
  const audio = await (await h(post({ action: "create_upload", mime_type: "audio/mpeg", size_bytes: 3_000_000 }))).json();
  assert.match(audio.path, /^audio\/\d{4}\/[0-9a-f-]{36}\.mp3$/);
  const m4a = await (await h(post({ action: "create_upload", mime_type: "audio/x-m4a", size_bytes: 1000 }))).json();
  assert.match(m4a.path, /\.m4a$/);
  const two = await (await h(post({ action: "create_upload", mime_type: "image/png", size_bytes: 10 }))).json();
  assert.notEqual(two.path, (await (await h(post({ action: "create_upload", mime_type: "image/png", size_bytes: 10 }))).json()).path, "every upload gets its own path");
});

Deno.test("create_upload refuses wrong types and sizes", async () => {
  const h = createHandler(() => fake().db);
  const refuse = async (over: Record<string, unknown>, msg: RegExp) => {
    const res = await h(post({ action: "create_upload", mime_type: "image/png", size_bytes: 1000, ...over }));
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, msg);
  };
  await refuse({ mime_type: "image/gif" }, /File type/);
  await refuse({ mime_type: "image/svg+xml" }, /File type/);
  await refuse({ mime_type: "application/pdf" }, /File type/);
  await refuse({ size_bytes: IMAGE_MAX_BYTES + 1 }, /between 1 and/);
  await refuse({ mime_type: "audio/mpeg", size_bytes: AUDIO_MAX_BYTES + 1 }, /between 1 and/);
  await refuse({ size_bytes: 0 }, /between 1 and/);
  await refuse({ size_bytes: "big" }, /whole number/);
});

Deno.test("only signed-in staff can use it, and purging is for admins", async () => {
  const { db } = fake();
  assert.equal((await createHandler(() => db)(post({ action: "signed_urls", ids: [] }, null))).status, 401);
  assert.equal((await createHandler(() => db)(post({ action: "signed_urls", ids: [] }, "bad"))).status, 401);
  assert.equal((await createHandler(() => db)(post({ action: "purge_unused" }))).status, 403, "a teacher cannot purge");
  assert.equal((await createHandler(() => fake({ role: "admin" }).db)(post({ action: "purge_unused" }))).status, 200);
  assert.equal((await createHandler(() => db)(new Request("http://x/", { method: "GET" }))).status, 405);
  assert.equal((await createHandler(() => db)(post({ action: "drop_table" }))).status, 400);
});

Deno.test("the scheduled housekeeping job can purge unused files, and only that", async () => {
  const key = "housekeeping-key-for-tests";
  const noToken = (body: unknown, header?: string) =>
    new Request("http://x/", {
      method: "POST",
      headers: { "content-type": "application/json", ...(header ? { "x-housekeeping-key": header } : {}) },
      body: JSON.stringify(body),
    });
  const { db, removed } = fake({ rpc: () => ({ data: ["image/2026/ffffffff-ffff-4fff-8fff-ffffffffffff.png"] }) });
  const h = createHandler(() => db);

  try {
    // With no key configured on the server, a presented key opens nothing (fail closed).
    assert.equal((await h(noToken({ action: "purge_unused" }, key))).status, 401, "no configured key means no scheduled path");

    Deno.env.set("HOUSEKEEPING_KEY", key);
    const res = await h(noToken({ action: "purge_unused" }, key));
    assert.equal(res.status, 200, "the job purges without a signed-in person");
    assert.equal((await res.json()).removed, 1);
    assert.deepEqual(removed, [["image/2026/ffffffff-ffff-4fff-8fff-ffffffffffff.png"]], "the bytes are deleted through Storage");

    assert.equal((await h(noToken({ action: "purge_unused" }, "wrong-key"))).status, 401, "a wrong key is not a session");
    assert.equal((await h(noToken({ action: "purge_unused" }))).status, 401, "no key at all is not a session");
    const upload = await h(noToken({ action: "create_upload", mime_type: "image/webp", size_bytes: 1000 }, key));
    assert.equal(upload.status, 401, "the key opens no other action");
    assert.equal((await h(noToken({ action: "signed_urls", ids: [] }, key))).status, 401);
  } finally {
    Deno.env.delete("HOUSEKEEPING_KEY");
  }
});

Deno.test("register reads the real size and type from Storage, not from the browser", async () => {
  const path = "image/2026/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.webp";
  const { db, rpcCalls, removed } = fake({ objects: { [path]: { size: 350_000, mimetype: "image/webp" } }, rpc: () => ({ data: M1 }) });
  const res = await createHandler(() => db)(post({ action: "register", path, name: "C:\\fakepath\\wallet.webp", duration_seconds: null, size_bytes: 1 }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.media.id, M1);
  assert.equal(body.media.size_bytes, 350_000);
  assert.equal(rpcCalls[0].name, "register_media");
  assert.deepEqual(rpcCalls[0].args, { p_path: path, p_kind: "image", p_mime: "image/webp", p_size: 350_000, p_name: "wallet.webp", p_duration: null, p_actor: TEACHER });
  assert.equal(removed.length, 0);
});

Deno.test("register refuses unfinished uploads and bad paths, and removes files the database refuses", async () => {
  const h1 = createHandler(() => fake({ objects: {} }).db);
  const missing = await h1(post({ action: "register", path: "image/2026/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.png" }));
  assert.equal(missing.status, 400);
  assert.match((await missing.json()).error, /did not finish/);
  for (const bad of ["../secret.png", "image/2026/x.exe", "video/2026/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.mp4", "image/26/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.png"]) {
    assert.equal((await h1(post({ action: "register", path: bad }))).status, 400, bad);
  }
  const path = "image/2026/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.png";
  const { db, removed } = fake({ objects: { [path]: { size: 9_000_000, mimetype: "image/png" } }, rpc: () => ({ error: { message: "Images must be JPG, PNG, or WebP and about 1 MB or smaller.", hint: "validation" } }) });
  const res = await createHandler(() => db)(post({ action: "register", path }));
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /about 1 MB/);
  assert.deepEqual(removed, [[path]], "the refused file is deleted from Storage");
});

Deno.test("signed_urls maps ids to short-lived links", async () => {
  const { db } = fake({ rpc: () => ({ data: [{ id: M1, path: "audio/2026/cccccccc-cccc-4ccc-8ccc-cccccccccccc.mp3", kind: "audio" }, { id: M2, path: "image/2026/dddddddd-dddd-4ddd-8ddd-dddddddddddd.jpg", kind: "image" }] }) });
  const res = await createHandler(() => db)(post({ action: "signed_urls", ids: [M1, M2] }));
  const body = await res.json();
  assert.ok(body.urls[M1].includes("cccccccc") && body.urls[M2].includes("dddddddd"));
  assert.equal(body.expires_in, 3600);
  assert.equal((await createHandler(() => db)(post({ action: "signed_urls", ids: ["nope"] }))).status, 400);
  assert.equal((await createHandler(() => db)(post({ action: "signed_urls", ids: new Array(21).fill(M1) }))).status, 400);
});

Deno.test("signed_urls answers with no links when every id is unknown (a purged file is not an error)", async () => {
  const { db, signed } = fake({ rpc: () => ({ data: [] }) });
  const res = await createHandler(() => db)(post({ action: "signed_urls", ids: [M1] }));
  assert.equal(res.status, 200, "asking for a file that is gone is not a server error");
  assert.deepEqual(await res.json(), { urls: {} });
  assert.equal(signed.length, 0, "Storage is never asked to sign an empty list");
});

Deno.test("purge_unused removes the files the database says nobody uses", async () => {
  const { db, removed } = fake({ role: "admin", rpc: () => ({ data: ["image/2026/eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee.png"] }) });
  const body = await (await createHandler(() => db)(post({ action: "purge_unused" }))).json();
  assert.equal(body.removed, 1);
  assert.deepEqual(removed, [["image/2026/eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee.png"]]);
});

Deno.test("question and passage input accept a list of file ids", () => {
  const q = parseQuestionInput({ action: "save", type: "essay", body: "Listen and explain.", media: [{ id: M1 }, M2] });
  assert.deepEqual(q.payload.media, [{ id: M1 }, { id: M2 }]);
  assert.equal("media" in parseQuestionInput({ action: "save", type: "essay", body: "No files sent." }).payload, false, "no list means: leave files alone");
  assert.deepEqual(parseQuestionInput({ action: "save", type: "essay", body: "Clear.", media: [] }).payload.media, []);
  assert.throws(() => parseQuestionInput({ action: "save", type: "essay", body: "x", media: new Array(5).fill(M1) }), /at most 4/);
  assert.throws(() => parseQuestionInput({ action: "save", type: "essay", body: "x", media: ["nope"] }), /not a valid id/);
  assert.deepEqual(parsePassageInput({ title: "T", body: "B", media: [M1] }).payload.media, [{ id: M1 }]);
});
