import { handle, readJson } from "../_shared/http.ts";
import { methodNotAllowed, notFound } from "../_shared/errors.ts";
import { requireStaff, type StaffDb } from "../_shared/auth.ts";
import { callRpc, type RpcDb } from "../_shared/rpc.ts";
import { asEnum, asObject, asUuid, optional } from "../_shared/validate.ts";
import {
  ACCESS_CODE_PATTERN,
  generateAccessCode,
  normalizeAccessCode,
} from "../_shared/codes.ts";
import { badRequest } from "../_shared/errors.ts";
import {
  EXAM_STATUSES,
  parseBulkQuestions,
  parseExamInput,
  parseListFilters,
} from "./parse.ts";

export type Db = StaffDb & RpcDb;

const ACTIONS = [
  "list",
  "get",
  "save",
  "remove",
  "set_status", // open / close / back to draft (BR-03, BR-04)
  "regenerate_code", // BR-17: new automatic code
  "check_code", // is this code free among open exams?
  "duplicate", // copy an exam (or template) as a new draft
  "bulk_questions", // put many bank questions on an exam, or take many off it (F-18)
  "readiness", // pre-flight check before Open (TASK-041)
] as const;

/** Codes are typed by students on shared keyboards; a stray space must not fail the check. */
const cleanedCode = (raw: unknown, path: string) => {
  const code = normalizeAccessCode(typeof raw === "string" ? raw : "");
  if (!ACCESS_CODE_PATTERN.test(code)) {
    throw badRequest(
      `${path} must be 4 to 12 letters and digits, without spaces.`,
    );
  }
  return code;
};

/**
 * Exams for teachers and admins. One endpoint, POST { action, ... }.
 * All writes are database functions (one transaction each, with the audit entry inside), DEC-004.
 */
export function createHandler(getDb: () => Db) {
  return handle(async (req) => {
    if (req.method !== "POST") throw methodNotAllowed();
    const db = getDb();
    const b = asObject(await readJson(req, 200_000));
    const action = asEnum(b.action, "action", ACTIONS);
    // Deleting an exam that already has attempts (`hard: true`) also deletes those attempts and their
    // results, so it is an admin job (ISSUE-023). Without it a teacher may only close such an exam.
    const permanent = action === "remove" && b.hard === true;
    const me = await requireStaff(
      req,
      db,
      permanent ? ["admin"] : ["teacher", "admin"],
    );

    switch (action) {
      case "list":
        return {
          exams: await callRpc(db, "list_exams", {
            p: parseListFilters(b),
            p_actor: me.userId,
          }),
        };

      case "get": {
        const exam = await callRpc(db, "get_exam", {
          p_id: asUuid(b.id, "id"),
          p_actor: me.userId,
        });
        if (!exam) throw notFound("That exam no longer exists.");
        return { exam };
      }

      case "save": {
        const { id, payload } = parseExamInput(b);
        const savedId = await callRpc<string>(db, "save_exam", {
          p_id: id ?? null,
          p: payload,
          p_actor: me.userId,
        });
        return { id: savedId };
      }

      case "remove":
        return {
          result: await callRpc<string>(db, "remove_exam", {
            p_id: asUuid(b.id, "id"),
            p_actor: me.userId,
            p_force: permanent,
          }),
        };

      case "set_status": {
        const status = asEnum(b.status, "Status", EXAM_STATUSES);
        await callRpc(db, "set_exam_status", {
          p_id: asUuid(b.id, "id"),
          p_status: status,
          p_actor: me.userId,
        });
        return { ok: true };
      }

      case "regenerate_code":
        return {
          code: await callRpc<string>(db, "regenerate_exam_code", {
            p_id: asUuid(b.id, "id"),
            p_actor: me.userId,
          }),
        };

      case "check_code": {
        const code = cleanedCode(b.code, "Test code");
        // The SQL names the holder of the code — 'open', 'draft', or null — so the editor can warn that
        // another draft holds it before Open, when the conflict is still avoidable (TASK-031). A code an
        // open exam holds stays unavailable.
        const holder = await callRpc<string | null>(db, "exam_code_used_by", {
          p_code: code,
          p_exclude: optional(b.exclude_id, (v) => asUuid(v, "exclude_id")) ??
            null,
        });
        return { available: holder !== "open", used_by: holder };
      }

      case "duplicate": {
        const newId = await callRpc<string>(db, "duplicate_exam", {
          p_id: asUuid(b.id, "id"),
          p_actor: me.userId,
        });
        return { id: newId };
      }

      // Adding or removing many questions at once is one database act (one transaction, one audit entry)
      // with its own guards; every refusal comes back as a friendly 400 through callRpc.
      case "bulk_questions": {
        const { examId, mode, ids } = parseBulkQuestions(b);
        const result = await callRpc<Record<string, unknown>>(
          db,
          "bulk_exam_questions",
          {
            p_exam_id: examId,
            p_mode: mode,
            p_ids: ids,
            p_actor: me.userId,
          },
        );
        return { result };
      }

      case "readiness": {
        const examId = asUuid(b.id, "id");
        const readiness = await callRpc(db, "exam_readiness", {
          p_id: examId,
          p_actor: me.userId,
        });
        return { readiness };
      }
    }
  });
}

/** A fresh code suggestion for the editor ("Make a new one"). Not an action; used by the client through generate. */
export function suggestCode(): string {
  return generateAccessCode();
}
