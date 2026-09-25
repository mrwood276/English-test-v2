import { handle, readJson } from "../_shared/http.ts";
import { methodNotAllowed, notFound } from "../_shared/errors.ts";
import { requireStaff, type StaffDb } from "../_shared/auth.ts";
import { callRpc, type RpcDb } from "../_shared/rpc.ts";
import { asArray, asEnum, asObject, asPlain, asString, asUuid, optional } from "../_shared/validate.ts";
import { sanitizeInlineHtml } from "../_shared/text.ts";
import { parseImportCheckItems, parseImportItems, parseListFilters, parsePassageInput, parseQuestionInput } from "./parse.ts";

export type Db = StaffDb & RpcDb;

const ACTIONS = [
  "list", "get", "save", "remove", "archive", "restore", "check_duplicates",
  "duplicate_groups",
  "topics", "class_labels",
  "passages", "passage_get", "passage_save", "passage_remove",
  "import_check", "import",
] as const;

/** Similarity from which a question is shown as "looks similar" (0 to 1). */
const SIMILARITY_THRESHOLD = 0.55;

/**
 * Question bank for teachers and admins. One endpoint, POST { action, ... }.
 * All writes are database functions (one transaction each, with the audit entry inside).
 */
export function createHandler(getDb: () => Db) {
  return handle(async (req) => {
    if (req.method !== "POST") throw methodNotAllowed();
    const db = getDb();
    const me = await requireStaff(req, db);
    const b = asObject(await readJson(req, 1_000_000));
    const action = asEnum(b.action, "action", ACTIONS);

    switch (action) {
      case "list":
        return await callRpc(db, "list_questions", { p: parseListFilters(b) });

      case "get": {
        const question = await callRpc(db, "get_question", { p_id: asUuid(b.id, "id") });
        if (!question) throw notFound("That question no longer exists.");
        return { question };
      }

      case "save": {
        const { id, payload } = parseQuestionInput(b);
        const savedId = await callRpc<string>(db, "save_question", { p_id: id ?? null, p: payload, p_actor: me.userId });
        return { id: savedId };
      }

      case "remove":
        return { result: await callRpc<string>(db, "remove_question", { p_id: asUuid(b.id, "id"), p_actor: me.userId }) };

      case "archive":
      case "restore":
        await callRpc(db, "set_question_archived", { p_id: asUuid(b.id, "id"), p_archived: action === "archive", p_actor: me.userId });
        return { ok: true };

      case "check_duplicates": {
        const body = sanitizeInlineHtml(asString(b.body, "The question", { min: 1, max: 5000 }));
        const options = asArray(b.options ?? [], "Answers", { max: 10 }).map((v, i) => sanitizeInlineHtml(asString(v, `Answer ${i + 1}`, { max: 1000 })).trim());
        const matches = await callRpc(db, "find_similar_questions", {
          p_body: body,
          p_options: options,
          p_exclude: optional(b.exclude_id, (v) => asUuid(v, "exclude_id")) ?? null,
          p_threshold: SIMILARITY_THRESHOLD,
        });
        return { matches };
      }

      case "duplicate_groups":
        return await callRpc(db, "find_duplicate_groups");

      case "topics":
        return { topics: await callRpc(db, "list_topics") };

      case "class_labels":
        return { labels: await callRpc(db, "list_class_labels", { p_prefix: optional(b.prefix, (v) => asPlain(v, "Prefix", { max: 40 })) ?? null }) };

      case "passages":
        return { passages: await callRpc(db, "list_passages", { p_q: optional(b.q, (v) => asString(v, "Search", { max: 100 })) ?? null }) };

      case "passage_get": {
        const passage = await callRpc(db, "get_passage", { p_id: asUuid(b.id, "id") });
        if (!passage) throw notFound("That reading text no longer exists.");
        return { passage };
      }

      case "passage_save": {
        const { id, payload } = parsePassageInput(b);
        return { id: await callRpc<string>(db, "save_passage", { p_id: id ?? null, p: payload, p_actor: me.userId }) };
      }

      case "import_check": {
        const items = parseImportCheckItems(b.items);
        const results = await callRpc(db, "find_similar_batch", { p_items: items, p_threshold: SIMILARITY_THRESHOLD });
        return { results };
      }

      case "import": {
        const items = parseImportItems(b.items);
        return await callRpc(db, "import_questions", { p_items: items, p_actor: me.userId });
      }

      case "passage_remove":
        await callRpc(db, "remove_passage", { p_id: asUuid(b.id, "id"), p_actor: me.userId });
        return { ok: true };
    }
  });
}

