import { handle, readJson } from "../_shared/http.ts";
import { methodNotAllowed, unauthorized } from "../_shared/errors.ts";
import { callRpc, type RpcDb } from "../_shared/rpc.ts";
import { asEnum, asObject, asString, asUuid, optional } from "../_shared/validate.ts";
import { clientKey, rateLimit, type RpcClient } from "../_shared/ratelimit.ts";
import {
  MAX_ANSWER_CHARS,
  parseAnswers,
  parseEventMeta,
  parseEventType,
  parseJoin,
  parseReason,
  SESSION_ACTIONS,
} from "./parse.ts";
import { sessionTokenSecret, signSessionToken, verifySessionToken } from "./token.ts";

/**
 * The student exam engine. This is the only endpoint a student (no account) can call.
 *
 * - Every action is one database function (DEC-004); the answer key never leaves the server (BR-09).
 * - `join` is the only open action and is rate limited by address (BR-21); every other action needs a
 *   signed session token (DEC-022).
 * - Bodies are small: answers are text only; images and audio are uploaded by the teacher and viewed
 *   through short-lived links from the `media` action.
 */
export const SESSION_BUCKET = "question-media"; // same private bucket as the teacher's media function
export const SESSION_SIGNED_URL_SECONDS = 3600;

export interface SignedUrlBucket {
  createSignedUrls(
    paths: string[],
    expiresIn: number,
  ): PromiseLike<{ data: { path: string | null; signedUrl: string; error: string | null }[] | null; error: { message: string } | null }>;
}

export type Db = RpcDb & RpcClient & { storage: { from(bucket: string): SignedUrlBucket } };

/** Kept generous on purpose: a whole class can share one school network address. */
const JOIN_LIMIT_PER_MINUTE = 60;
/** Autosave is limited per session, not per address, so many phones behind one network are fine. */
const SAVE_LIMIT_PER_MINUTE = 120;
const EVENT_LIMIT_PER_MINUTE = 120;

export function createHandler(getDb: () => Db, opts: { secret?: string } = {}) {
  const secret = () => opts.secret ?? sessionTokenSecret();

  return handle(async (req) => {
    if (req.method !== "POST") throw methodNotAllowed();
    const db = getDb();
    const b = asObject(await readJson(req, 2_000_000));
    const action = asEnum(b.action, "action", SESSION_ACTIONS);

    if (action === "join") {
      const input = parseJoin(b);
      await rateLimit(db, "session_join", clientKey(req), { limit: JOIN_LIMIT_PER_MINUTE, windowSeconds: 60 });
      const data = asObject(await callRpc(db, "exam_join", { p: input }), "session");
      const session = asObject(data.session, "session");
      const sessionId = asUuid(session.id, "session id");
      // The browser keeps this token; it is the only way back into this session.
      return {
        token: await signSessionToken(sessionId, secret()),
        session: data.session,
        questions: data.questions,
        answers: data.answers,
      };
    }

    const sessionId = await verifySessionToken(asString(b.token, "token", { min: 10, max: 200 }), secret());
    if (!sessionId) throw unauthorized("This test session is no longer valid. Please join again.");

    switch (action) {
      case "get":
        return await callRpc(db, "get_exam_session", { p_id: sessionId });

      case "save": {
        const answers = parseAnswers(b);
        await rateLimit(db, "session_save", sessionId, { limit: SAVE_LIMIT_PER_MINUTE, windowSeconds: 60 });
        return await callRpc(db, "save_session_answers", { p_id: sessionId, p_answers: answers });
      }

      case "heartbeat":
        return await callRpc(db, "session_heartbeat", { p_id: sessionId });

      case "event": {
        const eventType = parseEventType(b.event_type);
        await rateLimit(db, "session_event", sessionId, { limit: EVENT_LIMIT_PER_MINUTE, windowSeconds: 60 });
        return await callRpc(db, "log_session_event", {
          p_id: sessionId,
          p_event_type: eventType,
          p_meta: parseEventMeta(b.meta),
        });
      }

      case "submit":
        return await callRpc(db, "submit_exam_session", {
          p_id: sessionId,
          p_reason: optional(b.reason, parseReason) ?? "student",
        });

      case "result":
        return await callRpc(db, "get_session_result", { p_id: sessionId });

      case "media": {
        // Only files that are part of this session's own snapshot can be signed.
        const ids = await callRpc<string[]>(db, "get_session_media_ids", { p_id: sessionId });
        if (!ids || ids.length === 0) return { urls: {}, expires_in: SESSION_SIGNED_URL_SECONDS };
        const rows = await callRpc<{ id: string; path: string }[]>(db, "get_media_paths", { p_ids: ids });
        const { data, error } = await db.storage.from(SESSION_BUCKET).createSignedUrls(
          rows.map((r) => r.path),
          SESSION_SIGNED_URL_SECONDS,
        );
        if (error || !data) throw new Error(`could not create viewing links: ${error?.message}`);
        const byPath = new Map(data.map((d) => [d.path, d.signedUrl]));
        const urls: Record<string, string> = {};
        for (const row of rows) {
          const url = byPath.get(row.path);
          if (url) urls[row.id] = url;
        }
        return { urls, expires_in: SESSION_SIGNED_URL_SECONDS };
      }
    }
  });
}

export { MAX_ANSWER_CHARS };
