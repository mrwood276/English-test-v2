import { handle, readJson } from "../_shared/http.ts";
import { badRequest, methodNotAllowed } from "../_shared/errors.ts";
import { isScheduledJob, requireStaff, type StaffDb } from "../_shared/auth.ts";
import { callRpc, type RpcDb } from "../_shared/rpc.ts";
import { asArray, asEnum, asInt, asObject, asPlain, asString, asUuid, optional } from "../_shared/validate.ts";

export const BUCKET = "question-media";
export const IMAGE_MAX_BYTES = 1_500_000; // "about 1 MB": the browser shrinks images to about 1 MB first
export const AUDIO_MAX_BYTES = 10_485_760;
export const SIGNED_URL_SECONDS = 3600;

const MIME_TO_EXT = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
} as const;
const MIME_TYPES = Object.keys(MIME_TO_EXT) as (keyof typeof MIME_TO_EXT)[];
const PATH_RE = /^(image|audio)\/(\d{4})\/([0-9a-f-]{36}\.(?:jpg|png|webp|mp3|m4a))$/;

/** The part of the Storage client this function needs, so it can be tested without Supabase. */
export interface StorageBucket {
  createSignedUploadUrl(path: string): PromiseLike<{ data: { signedUrl: string; token: string; path: string } | null; error: { message: string } | null }>;
  list(path: string, options: { limit: number; search: string }): PromiseLike<{ data: { name: string; metadata?: { size?: number; mimetype?: string } | null }[] | null; error: { message: string } | null }>;
  remove(paths: string[]): PromiseLike<{ error: { message: string } | null }>;
  createSignedUrls(paths: string[], expiresIn: number): PromiseLike<{ data: { path: string | null; signedUrl: string; error: string | null }[] | null; error: { message: string } | null }>;
}
export type Db = StaffDb & RpcDb & { storage: { from(bucket: string): StorageBucket } };

const ACTIONS = ["create_upload", "register", "signed_urls", "purge_unused"] as const;

const kindOf = (mime: string) => (mime.startsWith("image/") ? "image" : "audio") as "image" | "audio";
const fileName = (raw: unknown) => asPlain(raw ?? "file", "File name", { max: 400 }).split(/[\\/]/).pop()!.slice(0, 200);

/**
 * The database lists the files nobody attached any more and then deletes those rows; the bytes can only
 * go away through the Storage API, which is why this half lives here and not in the nightly SQL job.
 */
async function purgeUnused(db: Db) {
  const paths = (await callRpc<string[] | null>(db, "purge_orphan_media", { p_older_than: "1 day" })) ?? [];
  if (paths.length > 0) {
    const { error } = await db.storage.from(BUCKET).remove(paths);
    if (error) throw new Error(`could not remove files: ${error.message}`);
  }
  return { removed: paths.length };
}

/**
 * Images and audio for questions. The browser never gets storage keys: it asks for a one-time upload link,
 * uploads the file straight to private Storage, then asks us to register it (we read the real size and type
 * from Storage instead of trusting the browser). Viewing uses short-lived links.
 */
export function createHandler(getDb: () => Db) {
  return handle(async (req) => {
    if (req.method !== "POST") throw methodNotAllowed();
    const db = getDb();
    const b = asObject(await readJson(req, 50_000));
    const action = asEnum(b.action, "action", ACTIONS);

    // The nightly housekeeping job (pg_cron → pg_net) has no signed-in person: its key opens the purge of
    // unused files and nothing else. Every other caller must be signed-in staff.
    if (action === "purge_unused" && await isScheduledJob(req)) return await purgeUnused(db);

    const me = await requireStaff(req, db, action === "purge_unused" ? ["admin"] : ["teacher", "admin"]);
    const bucket = db.storage.from(BUCKET);

    switch (action) {
      case "create_upload": {
        const mime = asEnum(b.mime_type, "File type", MIME_TYPES);
        const kind = kindOf(mime);
        const size = asInt(b.size_bytes, "File size", { min: 1, max: kind === "image" ? IMAGE_MAX_BYTES : AUDIO_MAX_BYTES });
        const path = `${kind}/${new Date().getUTCFullYear()}/${crypto.randomUUID()}.${MIME_TO_EXT[mime]}`;
        const { data, error } = await bucket.createSignedUploadUrl(path);
        if (error || !data) throw new Error(`could not create an upload link: ${error?.message}`);
        return { path, upload_url: data.signedUrl, max_bytes: kind === "image" ? IMAGE_MAX_BYTES : AUDIO_MAX_BYTES, size_bytes: size };
      }

      case "register": {
        const path = asString(b.path, "path", { min: 1, max: 200 });
        const m = PATH_RE.exec(path);
        if (!m) throw badRequest("The file location is not valid.");
        const [, kind, year, name] = m;
        const { data: found, error } = await bucket.list(`${kind}/${year}`, { limit: 5, search: name });
        if (error) throw new Error(`storage lookup failed: ${error.message}`);
        const object = (found ?? []).find((o) => o.name === name);
        const size = object?.metadata?.size;
        const mime = object?.metadata?.mimetype;
        if (!object || typeof size !== "number" || typeof mime !== "string") throw badRequest("The upload did not finish. Please try again.");
        try {
          const id = await callRpc<string>(db, "register_media", {
            p_path: path,
            p_kind: kind,
            p_mime: mime,
            p_size: size,
            p_name: fileName(b.name),
            p_duration: optional(b.duration_seconds, (v) => asInt(v, "Length", { min: 0, max: 7200 })) ?? null,
            p_actor: me.userId,
          });
          return { media: { id, kind, mime_type: mime, size_bytes: size, name: fileName(b.name), duration_seconds: b.duration_seconds ?? null } };
        } catch (err) {
          await bucket.remove([path]); // a refused file must not stay in Storage
          throw err;
        }
      }

      case "signed_urls": {
        const ids = asArray(b.ids, "ids", { max: 20 }).map((v) => asUuid(v, "id"));
        if (ids.length === 0) return { urls: {} };
        const rows = await callRpc<{ id: string; path: string }[]>(db, "get_media_paths", { p_ids: ids });
        // Every id unknown (a file the nightly purge has already removed, say) means there is nothing to
        // sign; Storage refuses an empty list, and "no links" is the honest answer here anyway.
        if (rows.length === 0) return { urls: {} };
        const { data, error } = await bucket.createSignedUrls(rows.map((r) => r.path), SIGNED_URL_SECONDS);
        if (error || !data) throw new Error(`could not create viewing links: ${error?.message}`);
        const byPath = new Map(data.map((d) => [d.path, d.signedUrl]));
        const urls: Record<string, string> = {};
        for (const r of rows) {
          const url = byPath.get(r.path);
          if (url) urls[r.id] = url;
        }
        return { urls, expires_in: SIGNED_URL_SECONDS };
      }

      case "purge_unused": {
        return await purgeUnused(db);
      }
    }
  });
}
