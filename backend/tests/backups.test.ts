import assert from "node:assert/strict";
import { createHandler, type Db, type BackupBucket, MAX_ARCHIVE_BYTES } from "../functions/backups/handler.ts";
import { crc32, zipStore } from "../functions/backups/zip.ts";

const ADMIN = "22222222-2222-4222-8222-222222222222";
const BACKUP_ID = "55555555-5555-4555-8555-555555555555";
const MEDIA_PATH = "image/2026/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.png";
const bytesOf = (text: string) => new TextEncoder().encode(text);

/** Reads a store-only zip back the way an unzip tool does: through its central directory. */
function entriesOf(zip: Uint8Array) {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const eocd = zip.byteLength - 22;
  assert.equal(view.getUint32(eocd, true), 0x06054b50, "ends with the end-of-central-directory record");
  const count = view.getUint16(eocd + 10, true);
  let at = view.getUint32(eocd + 16, true);
  const out: { name: string; bytes: Uint8Array; crc: number }[] = [];
  for (let i = 0; i < count; i++) {
    assert.equal(view.getUint32(at, true), 0x02014b50, "central directory entry");
    assert.equal(view.getUint16(at + 10, true), 0, "stored, not deflated");
    const crc = view.getUint32(at + 16, true);
    const size = view.getUint32(at + 20, true);
    const nameLength = view.getUint16(at + 28, true);
    const name = new TextDecoder().decode(zip.subarray(at + 46, at + 46 + nameLength));
    const start = view.getUint32(at + 42, true);
    assert.equal(view.getUint32(start, true), 0x04034b50, "local header where the directory says");
    const dataAt = start + 30 + nameLength;
    out.push({ name, bytes: zip.subarray(dataAt, dataAt + size), crc });
    at += 46 + nameLength;
  }
  return out;
}

function fake(opts: {
  role?: "teacher" | "admin";
  payload?: unknown;
  media?: Record<string, string>;
  recorded?: unknown;
  listed?: unknown;
  signedUrlError?: string;
  uploadError?: string;
  pruned?: string[];
} = {}) {
  const stored = new Map<string, Uint8Array>();
  const removed: string[][] = [];
  const downloaded: string[] = [];
  const rpcCalls: { name: string; args: Record<string, unknown> }[] = [];
  const bucket: BackupBucket = {
    download: (path) => {
      downloaded.push(path);
      const text = opts.media?.[path];
      return Promise.resolve({ data: text === undefined ? null : new Blob([bytesOf(text)]), error: text === undefined ? { message: "not found" } : null });
    },
    upload: (path, body) => {
      if (opts.uploadError) return Promise.resolve({ error: { message: opts.uploadError } });
      stored.set(path, body);
      return Promise.resolve({ error: null });
    },
    remove: (paths) => {
      removed.push(paths);
      return Promise.resolve({ error: null });
    },
    createSignedUrl: (path, expiresIn, options) => {
      if (opts.signedUrlError) return Promise.resolve({ data: null, error: { message: opts.signedUrlError } });
      return Promise.resolve({ data: { signedUrl: `https://storage.test/${path}?token=t&download=${options?.download ?? ""}` }, error: null });
    },
  };
  const db: Db = {
    auth: { getUser: (t: string) => Promise.resolve(t === "good" ? { data: { user: { id: ADMIN } }, error: null } : { data: { user: null }, error: { message: "bad" } }) },
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: { id: ADMIN, full_name: "Admin", role: opts.role ?? "admin", is_active: true }, error: null }) }) }) }),
    rpc: (name: string, args: Record<string, unknown> = {}) => {
      rpcCalls.push({ name, args });
      if (name === "build_backup_payload") return Promise.resolve({ data: opts.payload ?? { format: "english-test-v2.backup", format_version: 1, migrations: ["20260926010636"], tables: { questions: [{ id: "q1" }], exams: [] }, media: [] }, error: null });
      if (name === "record_backup") return Promise.resolve({ data: opts.recorded ?? { id: BACKUP_ID, kind: kindOf(args), created_at: "2026-09-26T01:10:00Z", storage_path: args.p_storage_path, size_bytes: args.p_size_bytes, pruned_paths: opts.pruned ?? [] }, error: null });
      if (name === "list_backups") return Promise.resolve({ data: opts.listed ?? { total: 0, rows: [] }, error: null });
      if (name === "get_backup") return Promise.resolve({ data: { storage_path: "20260926T011000Z_manual_1a2b3c4d.zip" }, error: null });
      if (name === "delete_backup") return Promise.resolve({ data: { storage_path: "20260926T011000Z_manual_1a2b3c4d.zip" }, error: null });
      return Promise.resolve({ data: null, error: null });
    },
    storage: { from: (b: string) => { assert.ok(b === "backups" || b === "question-media"); return bucket; } },
  };
  return { db, stored, removed, downloaded, rpcCalls };
}
const kindOf = (args: Record<string, unknown>) => String(args.p_kind ?? "manual");
const post = (body: unknown, token: string | null = "good", header?: string) =>
  new Request("http://x/", {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...(header ? { "x-housekeeping-key": header } : {}) },
    body: JSON.stringify(body),
  });

Deno.test("zipStore writes a store-only archive an unzip tool can read back", () => {
  const data = bytesOf('{"a":1}');
  const media = bytesOf("PNG-bytes");
  const zip = zipStore([{ name: "data.json", bytes: data }, { name: "media/image/2026/x.png", bytes: media }], new Date("2026-09-26T01:10:00Z"));

  const entries = entriesOf(zip);
  assert.deepEqual(entries.map((e) => e.name), ["data.json", "media/image/2026/x.png"]);
  assert.equal(new TextDecoder().decode(entries[0].bytes), '{"a":1}');
  assert.deepEqual(Array.from(entries[1].bytes), Array.from(media));
  assert.equal(entries[0].crc, crc32(data), "the CRC in the directory matches the bytes");
  assert.equal(entries[1].crc, crc32(media));
  assert.equal(zip.length, zipStore([{ name: "data.json", bytes: data }, { name: "media/image/2026/x.png", bytes: media }], new Date("2026-09-26T01:10:00Z")).length, "the writer is deterministic for the same input");
  assert.notEqual(crc32(bytesOf("a")), crc32(bytesOf("b")));
  assert.throws(() => zipStore([{ name: "", bytes: data }]), /not valid/);
});

Deno.test("an admin creates a manual backup: data.json plus the media bytes, one file stored", async () => {
  const { db, stored, rpcCalls } = fake({
    payload: {
      format: "english-test-v2.backup", format_version: 1, generated_at: "2026-09-26T01:10:00Z",
      migrations: ["20260926010636"],
      tables: { questions: [{ id: "q1" }, { id: "q2" }], exams: [] },
      media: [{ id: "m1", path: MEDIA_PATH, kind: "image", mime_type: "image/png", size_bytes: 9, original_name: "wallet.png", duration_seconds: null }],
    },
    media: { [MEDIA_PATH]: "PNG-bytes" },
  });
  const res = await createHandler(() => db)(post({ action: "create" }));
  assert.equal(res.status, 200);
  const body = await res.json();

  assert.equal(body.backup.kind, "manual");
  assert.equal(body.files, 2, "data.json and the picture");
  assert.equal(body.media_included, true);
  assert.equal(body.pruned, 0);
  assert.equal(stored.size, 1, "exactly one file is stored");
  const [path, archive] = [...stored.entries()][0];
  assert.match(path, /^\d{8}T\d{6}Z_manual_[0-9a-f]{8}\.zip$/);

  const entries = entriesOf(archive);
  assert.deepEqual(entries.map((e) => e.name), ["data.json", `media/${MEDIA_PATH}`]);
  const document = JSON.parse(new TextDecoder().decode(entries[0].bytes));
  assert.equal(document.kind, "manual");
  assert.equal(document.format, "english-test-v2.backup");
  assert.deepEqual(document.counts, { questions: 2, exams: 0 }, "the manifest counts every table");
  assert.equal(document.media_included, true);
  assert.equal(document.media_note, null);
  assert.equal(document.media[0].included, true);
  assert.equal(document.created_for, "a signed-in admin");

  assert.equal(rpcCalls.at(-1)!.name, "record_backup");
  assert.deepEqual(rpcCalls.at(-1)!.args.p_kind, "manual");
  assert.equal(rpcCalls.at(-1)!.args.p_actor, ADMIN, "the admin is recorded as the creator");
  assert.equal(rpcCalls.at(-1)!.args.p_size_bytes, archive.length);
});

Deno.test("media that has gone missing does not fail a backup, it is reported", async () => {
  const { db, stored } = fake({
    payload: {
      format: "english-test-v2.backup", format_version: 1, generated_at: "x", migrations: [],
      tables: { questions: [] },
      media: [
        { id: "m1", path: "image/2026/gone.png", kind: "image", mime_type: "image/png", size_bytes: 5, original_name: null, duration_seconds: null },
        { id: "m2", path: MEDIA_PATH, kind: "image", mime_type: "image/png", size_bytes: 9, original_name: null, duration_seconds: null },
      ],
    },
    media: { [MEDIA_PATH]: "PNG-bytes" },
  });
  const body = await (await createHandler(() => db)(post({ action: "create" }))).json();
  assert.equal(body.media_included, false);
  assert.match(body.media_note, /missing from Storage/);
  const document = JSON.parse(new TextDecoder().decode(entriesOf([...stored.values()][0])[0].bytes));
  assert.equal(document.media[0].included, false);
  assert.equal(document.media[0].reason, "missing from Storage");
  assert.equal(document.media[1].included, true);
});

Deno.test("an archive too large for the platform leaves the remaining media out, and says so", async () => {
  const { db, stored } = fake({
    payload: {
      format: "english-test-v2.backup", format_version: 1, generated_at: "x", migrations: [],
      tables: { questions: [] },
      media: [{ id: "m1", path: MEDIA_PATH, kind: "audio", mime_type: "audio/mpeg", size_bytes: MAX_ARCHIVE_BYTES + 1, original_name: null, duration_seconds: null }],
    },
    media: { [MEDIA_PATH]: "bytes" },
  });
  const body = await (await createHandler(() => db)(post({ action: "create" }))).json();
  assert.equal(body.media_included, false);
  assert.match(body.media_note, /45 MB/);
  assert.equal(entriesOf([...stored.values()][0]).length, 1, "only data.json is inside");
});

Deno.test("old automatic copies are deleted from Storage after the database pruned them", async () => {
  const pruned = ["20260918T034100Z_automatic_old1.zip", "20260919T034100Z_automatic_old2.zip"];
  const { db, removed } = fake({ pruned });
  const body = await (await createHandler(() => db)(post({ action: "create" }))).json();
  assert.equal(body.pruned, 2);
  assert.deepEqual(removed, [pruned], "the pruned files go, and nothing else");
});

Deno.test("a failure while recording never leaves the stored file behind", async () => {
  const { db, removed } = fake();
  db.rpc = ((name: string, args: Record<string, unknown> = {}) => {
    if (name === "build_backup_payload") return Promise.resolve({ data: { format: "f", format_version: 1, generated_at: "x", migrations: [], tables: {}, media: [] }, error: null });
    if (name === "record_backup") return Promise.resolve({ data: null, error: { message: "disk full", hint: null } });
    return Promise.resolve({ data: null, error: null });
  }) as typeof db.rpc;
  const res = await createHandler(() => db)(post({ action: "create" }));
  assert.equal(res.status, 500, "the person sees the generic error");
  assert.equal(removed.length, 1, "and the orphaned upload is deleted again");
});

Deno.test("the nightly job may create an automatic copy and nothing else", async () => {
  const key = "housekeeping-key-for-tests";
  const { db, rpcCalls } = fake();
  const h = createHandler(() => db);
  try {
    Deno.env.set("HOUSEKEEPING_KEY", key);
    const created = await h(post({ action: "create" }, null, key));
    assert.equal(created.status, 200, "the schedule creates a copy with no signed-in person");
    assert.equal((await created.json()).backup.kind, "automatic");
    assert.equal(rpcCalls.at(-1)!.args.p_kind, "automatic");
    assert.equal(rpcCalls.at(-1)!.args.p_actor, null, "a machine has no profile");

    for (const action of ["list", "download", "delete"]) {
      const res = await h(post({ action, id: BACKUP_ID }, null, key));
      assert.equal(res.status, 401, `the key opens no ${action}`);
    }
    assert.equal((await h(post({ action: "create" }, null, "wrong"))).status, 401, "a wrong key is not a session");
  } finally {
    Deno.env.delete("HOUSEKEEPING_KEY");
  }
});

Deno.test("only signed-in admins can use the endpoint, and the answers are friendly", async () => {
  const admin = fake({ listed: { total: 1, rows: [{ id: BACKUP_ID, kind: "manual" }] } });
  const teacher = fake({ role: "teacher" });
  const noPerson = fake();

  assert.equal((await createHandler(() => noPerson.db)(post({ action: "list" }, null))).status, 401);
  assert.equal((await createHandler(() => teacher.db)(post({ action: "list" }))).status, 403, "a teacher cannot see backups");
  assert.equal((await createHandler(() => teacher.db)(post({ action: "create" }))).status, 403, "nor make one");
  assert.equal((await createHandler(() => teacher.db)(post({ action: "delete", id: BACKUP_ID }))).status, 403);

  const listed = await createHandler(() => admin.db)(post({ action: "list", limit: 10, offset: 0 }));
  assert.deepEqual(await listed.json(), { backups: { total: 1, rows: [{ id: BACKUP_ID, kind: "manual" }] } });
  assert.equal((await createHandler(() => admin.db)(post({ action: "list", limit: 0 }))).status, 400);
  assert.equal((await createHandler(() => admin.db)(post({ action: "list", limit: 500 }))).status, 400);

  const download = await createHandler(() => admin.db)(post({ action: "download", id: BACKUP_ID }));
  const link = await download.json();
  assert.match(link.url, /^https:\/\/storage\.test\//);
  assert.equal(link.name, "english-test-v2_20260926T011000Z_manual_1a2b3c4d.zip", "the saved file has a name a person can keep");
  assert.equal(link.expires_in, 3600);
  assert.equal((await createHandler(() => admin.db)(post({ action: "download", id: "nope" }))).status, 400);

  const deleted = await createHandler(() => admin.db)(post({ action: "delete", id: BACKUP_ID }));
  assert.deepEqual(await deleted.json(), { id: BACKUP_ID, removed: 1 });

  assert.equal((await createHandler(() => admin.db)(post({ action: "drop_everything" }))).status, 400);
  assert.equal((await createHandler(() => admin.db)(new Request("http://x/", { method: "GET" }))).status, 405);
});
