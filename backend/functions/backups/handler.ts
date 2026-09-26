import { handle, readJson } from "../_shared/http.ts";
import { methodNotAllowed } from "../_shared/errors.ts";
import { isScheduledJob, requireStaff, type StaffDb } from "../_shared/auth.ts";
import { callRpc, type RpcDb } from "../_shared/rpc.ts";
import { asEnum, asInt, asObject, asUuid, optional } from "../_shared/validate.ts";
import { zipStore, type ZipEntry } from "./zip.ts";

export const BUCKET = "backups";
export const MEDIA_BUCKET = "question-media";
export const SIGNED_URL_SECONDS = 3600;
/** The platform refuses a single upload above 50 MB, so media is only added while the archive stays below this. */
export const MAX_ARCHIVE_BYTES = 45_000_000;

/** The part of the Storage client this function needs, so it can be tested without Supabase. */
export interface BackupBucket {
  download(path: string): PromiseLike<{ data: Blob | null; error: { message: string } | null }>;
  upload(
    path: string,
    body: Uint8Array,
    options: { contentType: string; upsert: boolean },
  ): PromiseLike<{ error: { message: string } | null }>;
  remove(paths: string[]): PromiseLike<{ error: { message: string } | null }>;
  createSignedUrl(
    path: string,
    expiresIn: number,
    options?: { download?: string },
  ): PromiseLike<{ data: { signedUrl: string } | null; error: { message: string } | null }>;
}
export type Db = StaffDb & RpcDb & { storage: { from(bucket: string): BackupBucket } };

const ACTIONS = ["create", "list", "download", "delete"] as const;

interface MediaRef {
  id: string;
  path: string;
  kind: string;
  mime_type: string;
  size_bytes: number | null;
  original_name: string | null;
  duration_seconds: number | null;
  included?: boolean;
  reason?: string;
}

interface BackupPayload {
  format: string;
  format_version: number;
  generated_at: string;
  migrations: string[];
  tables: Record<string, unknown[]>;
  media: MediaRef[];
}

interface RecordedBackup {
  id: string;
  kind: string;
  created_at: string;
  storage_path: string;
  size_bytes: number | null;
  pruned_paths: string[] | null;
}

const encoder = new TextEncoder();
const fileNameOf = (path: string) => `english-test-v2_${path.split("/").pop() ?? "backup.zip"}`;

/**
 * Backups (TASK-015, design.md's Backup/Recovery module — an admin job). One endpoint, POST { action }.
 *
 * The database reads itself (`build_backup_payload`) and keeps the `backups` table honest
 * (`record_backup` / `list_backups` / `get_backup` / `delete_backup`); this function is the only part that
 * touches Storage, because bytes need the Storage API: it zips data.json plus the attached picture/audio
 * bytes and stores ONE file per backup. A signed-in admin creates manual copies; the nightly `pg_cron` job
 * presents the housekeeping key (DEC-029) and may create automatic copies — and nothing else.
 */
export function createHandler(getDb: () => Db) {
  return handle(async (req) => {
    if (req.method !== "POST") throw methodNotAllowed();
    const db = getDb();
    const b = asObject(await readJson(req, 20_000));
    const action = asEnum(b.action, "action", ACTIONS);

    // The nightly job has no signed-in person: its key opens an automatic copy and nothing else.
    if (action === "create" && await isScheduledJob(req)) {
      return await createBackup(db, "automatic", null);
    }

    const me = await requireStaff(req, db, ["admin"]);

    switch (action) {
      case "create":
        return await createBackup(db, "manual", me.userId);

      case "list":
        return {
          backups: await callRpc(db, "list_backups", {
            p_limit: optional(b.limit, (v) => asInt(v, "Limit", { min: 1, max: 200 })) ?? 50,
            p_offset: optional(b.offset, (v) => asInt(v, "Offset", { min: 0, max: 1_000_000 })) ?? 0,
          }),
        };

      case "download": {
        const id = asUuid(b.id, "id");
        const row = await callRpc<{ storage_path: string }>(db, "get_backup", { p_id: id });
        const name = fileNameOf(row.storage_path);
        const { data, error } = await db.storage.from(BUCKET).createSignedUrl(row.storage_path, SIGNED_URL_SECONDS, { download: name });
        if (error || !data) throw new Error(`could not create a download link: ${error?.message}`);
        return { url: data.signedUrl, name, expires_in: SIGNED_URL_SECONDS };
      }

      case "delete": {
        const id = asUuid(b.id, "id");
        const gone = await callRpc<{ storage_path: string }>(db, "delete_backup", { p_id: id, p_actor: me.userId });
        const { error } = await db.storage.from(BUCKET).remove([gone.storage_path]);
        if (error) throw new Error(`could not remove the file: ${error.message}`);
        return { id, removed: 1 };
      }
    }
  });
}

/** Builds one archive: the payload from the database, plus the media bytes while they fit. */
async function createBackup(db: Db, kind: "manual" | "automatic", actorId: string | null) {
  const payload = await callRpc<BackupPayload>(db, "build_backup_payload");
  const bucket = db.storage.from(BUCKET);
  const mediaBucket = db.storage.from(MEDIA_BUCKET);
  const media = payload.media ?? [];

  const files: ZipEntry[] = [];
  let mediaBytes = 0;
  let mediaNote: string | null = null;

  for (const m of media) {
    const limit = Math.round(MAX_ARCHIVE_BYTES / 1_000_000);
    if (mediaBytes + (m.size_bytes ?? 0) > MAX_ARCHIVE_BYTES) {
      m.included = false;
      m.reason = "over the archive size limit";
      mediaNote ??= `This database's media is larger than the ${limit} MB a single archive can hold, so the ` +
        `remaining files were not copied. The data is complete; download those files from the question editor.`;
      continue;
    }
    const { data, error } = await mediaBucket.download(m.path);
    if (error || !data) {
      m.included = false;
      m.reason = "missing from Storage";
      mediaNote ??= "Some files were missing from Storage when this copy was made (the list says which).";
      continue;
    }
    const bytes = new Uint8Array(await data.arrayBuffer());
    mediaBytes += bytes.length;
    m.included = true;
    files.push({ name: `media/${m.path}`, bytes });
  }

  const counts = Object.fromEntries(Object.entries(payload.tables ?? {}).map(([table, rows]) => [table, rows.length]));
  const document = {
    ...payload,
    kind,
    counts,
    media_included: media.every((m) => m.included === true),
    media_bytes: mediaBytes,
    media_note: mediaNote,
    created_for: kind === "manual" ? "a signed-in admin" : "the nightly schedule",
  };

  const archive = zipStore([
    { name: "data.json", bytes: encoder.encode(JSON.stringify(document)) },
    ...files,
  ]);
  const path = archivePath(kind);

  const { error: uploadError } = await bucket.upload(path, archive, { contentType: "application/zip", upsert: false });
  if (uploadError) throw new Error(`could not store the backup: ${uploadError.message}`);

  try {
    const recorded = await callRpc<RecordedBackup>(db, "record_backup", {
      p_kind: kind,
      p_storage_path: path,
      p_size_bytes: archive.length,
      p_actor: actorId,
      p_summary: {
        tables: Object.keys(counts).length,
        files: files.length + 1,
        media_bytes: mediaBytes,
        media_included: media.every((m) => m.included === true),
      },
    });

    // Retention: the database dropped the rows of the copies that fell outside the window; their files go now.
    const pruned = recorded.pruned_paths ?? [];
    if (pruned.length > 0) {
      const { error } = await bucket.remove(pruned);
      if (error) throw new Error(`could not remove old copies: ${error.message}`);
    }

    return {
      backup: recorded,
      files: files.length + 1,
      media_included: document.media_included,
      media_note: mediaNote,
      pruned: pruned.length,
    };
  } catch (err) {
    await bucket.remove([path]); // never leave a file that no row points at
    throw err;
  }
}

/** `20260926T034100Z_manual_1a2b3c4d.zip` — sortable, says what it is, and cannot collide. */
function archivePath(kind: string, now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  return `${stamp}_${kind}_${crypto.randomUUID().slice(0, 8)}.zip`;
}
