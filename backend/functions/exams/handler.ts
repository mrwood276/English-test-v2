import { handle, readJson } from "../_shared/http.ts";
import { methodNotAllowed, notFound } from "../_shared/errors.ts";
import { requireStaff, type StaffDb } from "../_shared/auth.ts";
import { callRpc, type RpcDb } from "../_shared/rpc.ts";
import { asEnum, asObject, asUuid, optional } from "../_shared/validate.ts";
import { ACCESS_CODE_PATTERN, generateAccessCode, normalizeAccessCode } from "../_shared/codes.ts";
import { badRequest } from "../_shared/errors.ts";
import { asAccessCode, parseExamInput, parseListFilters, EXAM_STATUSES } from "./parse.ts";

export type Db = StaffDb & RpcDb;

const ACTIONS = [
  "list", "get", "save", "remove",
  "set_status",            // open / close / back to draft (BR-03, BR-04)
  "regenerate_code",       // BR-17: new automatic code
  "check_code",            // is this code free among open exams?
  "duplicate",             // copy an exam (or template) as a new draft
] as const;

/** Codes are typed by students on shared keyboards; a stray space must not fail the check. */
const cleanedCode = (raw: unknown, path: string) => {
  const code = normalizeAccessCode(typeof raw === "string" ? raw : "");
  if (!ACCESS_CODE_PATTERN.test(code)) throw badRequest(`${path} must be 4 to 12 letters and digits, without spaces.`);
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
    const me = await requireStaff(req, db);
    const b = asObject(await readJson(req, 200_000));
    const action = asEnum(b.action, "action", ACTIONS);

    switch (action) {
      case "list":
        return { exams: await callRpc(db, "list_exams", { p: parseListFilters(b) }) };

      case "get": {
        const exam = await callRpc(db, "get_exam", { p_id: asUuid(b.id, "id") });
        if (!exam) throw notFound("That exam no longer exists.");
        return { exam };
      }

      case "save": {
        const { id, payload } = parseExamInput(b);
        const savedId = await callRpc<string>(db, "save_exam", { p_id: id ?? null, p: payload, p_actor: me.userId });
        return { id: savedId };
      }

      case "remove":
        return { result: await callRpc<string>(db, "remove_exam", { p_id: asUuid(b.id, "id"), p_actor: me.userId }) };

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
        return { code: await callRpc<string>(db, "regenerate_exam_code", { p_id: asUuid(b.id, "id"), p_actor: me.userId }) };

      case "check_code": {
        const code = cleanedCode(b.code, "Test code");
        const free = await callRpc<boolean>(db, "exam_code_available", {
          p_code: code,
          p_exclude: optional(b.exclude_id, (v) => asUuid(v, "exclude_id")) ?? null,
        });
        return { available: free === true };
      }

      case "duplicate": {
        const newId = await callRpc<string>(db, "duplicate_exam", {
          p_id: asUuid(b.id, "id"),
          p_actor: me.userId,
        });
        return { id: newId };
      }
    }
  });
}

/** A fresh code suggestion for the editor ("Make a new one"). Not an action; used by the client through generate. */
export function suggestCode(): string {
  return generateAccessCode();
}
