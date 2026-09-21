import assert from "node:assert/strict";
import { normalizeText, contentHash, sanitizeInlineHtml } from "../functions/_shared/text.ts";
import { generateAccessCode, normalizeAccessCode, CODE_ALPHABET, ACCESS_CODE_PATTERN } from "../functions/_shared/codes.ts";
import { asString, asInt, asEnum, asUuid, asArray, asObject, asBool, optional } from "../functions/_shared/validate.ts";
import { ApiError, badRequest } from "../functions/_shared/errors.ts";
import { handle, readJson } from "../functions/_shared/http.ts";
import { requireStaff, bearerToken, type StaffDb } from "../functions/_shared/auth.ts";
import { rateLimit, type RpcClient } from "../functions/_shared/ratelimit.ts";
import { writeAudit } from "../functions/_shared/audit.ts";

// ---------- text rules ----------
Deno.test("normalizeText ignores case and extra whitespace, like the database", () => {
  assert.equal(normalizeText("  XII   TKJ A "), "xii tkj a");
  assert.equal(normalizeText("abc\n"), "abc");
  assert.equal(normalizeText("Budi\t\tSantoso"), "budi santoso");
  assert.equal(normalizeText(null), "");
});

Deno.test("contentHash matches the hashes stored by the database migration", async () => {
  const q5 = await contentHash("'When his ship <u>docked</u> at his hometown...' What is the synonym of the underlined word in context?", ["Sank", "Anchored / Parked", "Flew", "Sailed"]);
  assert.equal(q5, "e520c36e35f7096fddc2d1a5314d96d2d1b62f185a94fd91c4068caf379ddcbd");
  const q12 = await contentHash("Change to Simple Past Negative: 'Rudi installed the network cable last night.'", [
    "Rudi doesn't install the network cable last night.",
    "Rudi didn't installed the network cable last night.",
    "Rudi didn't install the network cable last night.",
    "Rudi was not install the network cable last night.",
  ]);
  assert.equal(q12, "0f4f790b11b3c43e3f6d47feda8560859b83ba78ea2bace67fa65abcdd52cfc4");
  const q20 = await contentHash("What is the negative form of 'They were testing the connection'?", [
    "They were not testing the connection.", "They did not testing the connection.", "They aren't testing the connection.", "They was not testing the connection.",
  ]);
  assert.equal(q20, "bd14eeb8cc78cd8c9a7c44543334e8084ded148225681307af992f136e43b474");
});

Deno.test("contentHash ignores option order, case, and spacing but not content", async () => {
  const a = await contentHash("Which is right?", ["Alpha", "Beta", "Gamma", "Delta"]);
  const b = await contentHash("  WHICH  is right? ", ["delta", "gamma ", "BETA", "alpha"]);
  const c = await contentHash("Which is right?", ["Alpha", "Beta", "Gamma", "Epsilon"]);
  assert.equal(a, b);
  assert.notEqual(a, c);
});

// ---------- HTML sanitizer ----------
Deno.test("sanitizeInlineHtml keeps simple formatting and removes everything else", () => {
  assert.equal(sanitizeInlineHtml("What is <u>docked</u>? <i>'Stop!'</i> <strong>Bold</strong><br>next"), "What is <u>docked</u>? <i>'Stop!'</i> <strong>Bold</strong><br>next");
  assert.equal(sanitizeInlineHtml("Hello <script>alert(1)</script>world"), "Hello world");
  assert.equal(sanitizeInlineHtml("<img src=x onerror=alert(1)>Hi"), "Hi");
  assert.equal(sanitizeInlineHtml('<b onclick="x()">bold</b>'), "<b>bold</b>");
  assert.equal(sanitizeInlineHtml('<a href="javascript:alert(1)">click</a>'), "click");
  assert.equal(sanitizeInlineHtml("<STRONG>X</STRONG><BR/>"), "<strong>X</strong><br>");
  assert.equal(sanitizeInlineHtml("1 < 2 and 3 > 2"), "1 &lt; 2 and 3 > 2");
  assert.equal(sanitizeInlineHtml("a<!-- hidden <script> -->b"), "ab");
  assert.equal(sanitizeInlineHtml("<style>body{display:none}</style>Text"), "Text");
  assert.equal(sanitizeInlineHtml("<svg onload=alert(1)><circle/></svg>ok"), "ok");
  assert.equal(sanitizeInlineHtml("<scr<script>ipt>alert(1)"), "&lt;scr");
  assert.equal(sanitizeInlineHtml("&lt;script&gt; stays as text"), "&lt;script&gt; stays as text");
});

Deno.test("sanitizeInlineHtml never outputs anything except allowed tags (fuzz)", () => {
  const frags = ["<", ">", "<b>", "</b>", "<script>", "</script>", "<img src=x onerror=1>", "text", " ", "&", '"', "'", "<!--", "-->", '<a href="javascript:x">', "</a>", "<svg onload=1>", "=", "/", "<br/>", "<u onmouseover=1>", "</", "<iframe src=x>", "<p>", "\n"];
  const safe = /^(?:[^<]|<\/?(?:b|strong|i|em|u|br|sub|sup)>)*$/;
  let seed = 12345;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let n = 0; n < 3000; n++) {
    const count = 1 + Math.floor(rnd() * 14);
    let s = "";
    for (let k = 0; k < count; k++) s += frags[Math.floor(rnd() * frags.length)];
    const out = sanitizeInlineHtml(s);
    assert.ok(safe.test(out), `unsafe output for input ${JSON.stringify(s)} -> ${JSON.stringify(out)}`);
  }
});

// ---------- exam codes ----------
Deno.test("generateAccessCode makes readable, valid, non-repeating codes", () => {
  const seen = new Set<string>();
  const counts = new Map<string, number>();
  for (let i = 0; i < 5000; i++) {
    const code = generateAccessCode();
    assert.equal(code.length, 6);
    assert.ok(ACCESS_CODE_PATTERN.test(code));
    for (const ch of code) {
      assert.ok(CODE_ALPHABET.includes(ch));
      counts.set(ch, (counts.get(ch) ?? 0) + 1);
    }
    seen.add(code);
  }
  assert.ok(seen.size > 4990, "codes should almost never repeat");
  assert.equal(counts.size, 32, "every character should be used");
  const values = [...counts.values()];
  assert.ok(Math.max(...values) / Math.min(...values) < 1.3, "characters should be evenly used");
  assert.ok(!/[01OI]/.test([...seen].join("")), "no confusing characters");
});

Deno.test("normalizeAccessCode accepts lower case and stray spaces", () => {
  assert.equal(normalizeAccessCode(" k7m 2qx "), "K7M2QX");
});

// ---------- validators ----------
Deno.test("validators accept good input and give friendly errors for bad input", () => {
  assert.equal(asString("  Aisyah  ", "Name", { min: 1, max: 80 }), "Aisyah");
  assert.throws(() => asString("   ", "Name", { min: 1, max: 80 }), /Name is required/);
  assert.throws(() => asString("x".repeat(81), "Name", { max: 80 }), /at most 80/);
  assert.throws(() => asString(42, "Name", { max: 80 }), /must be text/);
  assert.throws(() => asString("bad\u0000name", "Name", { max: 80 }), /not allowed/);
  assert.equal(asString("line1\nline2", "Answer", { max: 100 }), "line1\nline2");
  assert.equal(asInt(5, "Duration", { min: 1, max: 600 }), 5);
  assert.throws(() => asInt(5.5, "Duration", { min: 1, max: 600 }), /whole number/);
  assert.throws(() => asInt(0, "Duration", { min: 1, max: 600 }), /between 1 and 600/);
  assert.equal(asEnum("easy", "Difficulty", ["easy", "medium", "hots"] as const), "easy");
  assert.throws(() => asEnum("hard", "Difficulty", ["easy", "medium", "hots"] as const), /one of/);
  assert.equal(asUuid("3F2504E0-4F89-41D3-9A0C-0305E82C3301", "id"), "3f2504e0-4f89-41d3-9a0c-0305e82c3301");
  assert.throws(() => asUuid("nope", "id"), /not a valid id/);
  assert.throws(() => asArray([1, 2, 3], "Options", { max: 2 }), /at most 2/);
  assert.throws(() => asObject([], "body"), /must be an object/);
  assert.equal(asBool(true, "flag"), true);
  assert.throws(() => asBool("yes", "flag"), /true or false/);
  assert.equal(optional(undefined, () => 1), undefined);
  assert.equal(optional(null, () => 1), undefined);
  assert.equal(optional("x", () => 1), 1);
});

// ---------- http wrapper ----------
Deno.test("handle maps ApiError to its status and hides unexpected errors", async () => {
  const bad = handle(() => { throw badRequest("Name is required."); });
  const r1 = await bad(new Request("http://x/"));
  assert.equal(r1.status, 400);
  const b1 = await r1.json();
  assert.equal(b1.error, "Name is required.");
  assert.equal(b1.code, "bad_request");

  const secret = handle(() => { throw new Error("password=hunter2 at db.internal:5432"); });
  const origError = console.error;
  console.error = () => {};
  const r2 = await secret(new Request("http://x/"));
  console.error = origError;
  assert.equal(r2.status, 500);
  const b2 = await r2.json();
  assert.ok(!JSON.stringify(b2).includes("hunter2"));
  assert.equal(b2.code, "internal_error");
  assert.ok(typeof b2.requestId === "string");

  const ok = handle(() => ({ hello: "world" }));
  const r3 = await ok(new Request("http://x/"));
  assert.equal(r3.status, 200);
  assert.deepEqual(await r3.json(), { hello: "world" });
  assert.ok(r3.headers.get("access-control-allow-origin"));

  const pre = await ok(new Request("http://x/", { method: "OPTIONS" }));
  assert.equal(pre.status, 204);
  assert.ok(pre.headers.get("access-control-allow-headers")?.includes("authorization"));

  const limited = handle(() => { throw new ApiError(429, "too_many_requests", "Slow down.", { retryAfterSeconds: 60 }); });
  const r4 = await limited(new Request("http://x/"));
  assert.equal(r4.status, 429);
  assert.equal(r4.headers.get("retry-after"), "60");
});

Deno.test("readJson enforces size and validity", async () => {
  const good = await readJson(new Request("http://x/", { method: "POST", body: JSON.stringify({ a: 1 }) }));
  assert.deepEqual(good, { a: 1 });
  await assert.rejects(() => readJson(new Request("http://x/", { method: "POST", body: "{nope" })), /not valid JSON/);
  await assert.rejects(() => readJson(new Request("http://x/", { method: "POST", body: "" })), /no content/);
  await assert.rejects(() => readJson(new Request("http://x/", { method: "POST", body: JSON.stringify({ big: "x".repeat(500) }) }), 100), /too large/);
});

// ---------- staff auth ----------
function fakeDb(opts: { user?: { id: string } | null; profile?: { id: string; full_name: string; role: "teacher" | "admin"; is_active: boolean } | null; profileError?: string }): StaffDb {
  return {
    auth: { getUser: (_t: string) => Promise.resolve({ data: { user: opts.user ?? null }, error: opts.user ? null : { message: "bad token" } }) },
    from: (_table: string) => ({
      select: (_c: string) => ({
        eq: (_col: string, _v: string) => ({
          maybeSingle: () => Promise.resolve({ data: opts.profile ?? null, error: opts.profileError ? { message: opts.profileError } : null }),
        }),
      }),
    }),
  };
}
const withToken = (t?: string) => new Request("http://x/", { headers: t ? { authorization: `Bearer ${t}` } : {} });

Deno.test("requireStaff checks token, profile, activity, and role", async () => {
  assert.equal(bearerToken(withToken("abc")), "abc");
  assert.equal(bearerToken(withToken()), null);
  await assert.rejects(() => requireStaff(withToken(), fakeDb({})), (e: ApiError) => e.status === 401);
  await assert.rejects(() => requireStaff(withToken("t"), fakeDb({ user: null })), (e: ApiError) => e.status === 401);
  await assert.rejects(() => requireStaff(withToken("t"), fakeDb({ user: { id: "u1" }, profile: null })), (e: ApiError) => e.status === 403);
  await assert.rejects(() => requireStaff(withToken("t"), fakeDb({ user: { id: "u1" }, profile: { id: "u1", full_name: "A", role: "teacher", is_active: false } })), (e: ApiError) => e.status === 403);
  await assert.rejects(() => requireStaff(withToken("t"), fakeDb({ user: { id: "u1" }, profile: { id: "u1", full_name: "A", role: "teacher", is_active: true } }), ["admin"]), (e: ApiError) => e.status === 403);
  await assert.rejects(() => requireStaff(withToken("t"), fakeDb({ user: { id: "u1" }, profileError: "db down" })), /profile lookup failed/);
  const me = await requireStaff(withToken("t"), fakeDb({ user: { id: "u1" }, profile: { id: "u1", full_name: "Ms. Rina", role: "teacher", is_active: true } }));
  assert.deepEqual(me, { userId: "u1", role: "teacher", fullName: "Ms. Rina" });
});

// ---------- rate limit ----------
Deno.test("rateLimit allows up to the limit, then answers 429", async () => {
  let hits = 0;
  const db: RpcClient = { rpc: (_n, _a) => Promise.resolve({ data: ++hits, error: null }) };
  for (let i = 0; i < 3; i++) await rateLimit(db, "join", "1.2.3.4", { limit: 3, windowSeconds: 60 });
  await assert.rejects(() => rateLimit(db, "join", "1.2.3.4", { limit: 3, windowSeconds: 60 }), (e: ApiError) => e.status === 429);
  const broken: RpcClient = { rpc: () => Promise.resolve({ data: null, error: { message: "boom" } }) };
  await assert.rejects(() => rateLimit(broken, "join", "k", { limit: 3, windowSeconds: 60 }), /rate limit check failed/);
});

// ---------- audit ----------
Deno.test("writeAudit records an entry and never throws when the write fails", async () => {
  let saved: Record<string, unknown> | null = null;
  await writeAudit({ from: () => ({ insert: (row) => { saved = row; return Promise.resolve({ error: null }); } }) }, { actorId: "u1", action: "question.update", entityType: "question", entityId: "q1", changes: { difficulty: "hots" } });
  assert.deepEqual(saved, { actor_id: "u1", action: "question.update", entity_type: "question", entity_id: "q1", changes: { difficulty: "hots" } });
  const orig = console.error;
  console.error = () => {};
  await writeAudit({ from: () => ({ insert: () => Promise.resolve({ error: { message: "db down" } }) }) }, { actorId: null, action: "x", entityType: "y" });
  console.error = orig;
});
