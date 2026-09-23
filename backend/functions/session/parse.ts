import { asArray, asBool, asEnum, asObject, asPlain, asString, asUuid } from "../_shared/validate.ts";
import { badRequest } from "../_shared/errors.ts";
import { ACCESS_CODE_PATTERN, normalizeAccessCode } from "../_shared/codes.ts";

/** Student-side input parsing. Everything here is also checked again inside the SQL functions (BR-21). */

export const SESSION_ACTIONS = ["join", "get", "save", "heartbeat", "event", "submit", "result", "media"] as const;
export const SESSION_EVENT_TYPES = ["tab_hidden", "blur", "focus", "online", "offline", "reload", "submit", "reopen"] as const;
export const SUBMIT_REASONS = ["student", "time_up", "tab_switch_limit", "teacher"] as const;

export const MAX_ANSWERS_PER_SAVE = 200;
export const MAX_ANSWER_CHARS = 20_000;

const isBlank = (v: unknown) => v === undefined || v === null || (typeof v === "string" && v.trim() === "");

/** Name, class and the code from the board. */
export function parseJoin(b: Record<string, unknown>): Record<string, unknown> {
  const code = normalizeAccessCode(asString(b.code, "Test code", { min: 1, max: 12 }));
  if (!ACCESS_CODE_PATTERN.test(code)) throw badRequest("Test code must be 4 to 12 letters and digits.");
  return {
    code,
    name: asPlain(b.name, "Full name", { min: 2, max: 80 }),
    class: asPlain(b.class, "Class", { min: 1, max: 60 }),
  };
}

/** `answers` shaped for public.save_session_answers. A blank answer clears the question. */
export function parseAnswers(b: Record<string, unknown>): Record<string, unknown>[] {
  return asArray(b.answers ?? [], "Answers", { max: MAX_ANSWERS_PER_SAVE }).map((raw, i) => {
    const a = asObject(raw, `Answer ${i + 1}`);
    const given = isBlank(a.answer) ? {} : asObject(a.answer, `Answer ${i + 1} text`);
    const text = isBlank(given.text) ? "" : asString(given.text, `Answer ${i + 1} text`, { max: MAX_ANSWER_CHARS, trim: false });
    const out: Record<string, unknown> = {
      question_id: asUuid(a.question_id, `Answer ${i + 1} question id`),
      answer: { text },
      is_flagged: isBlank(a.is_flagged) ? false : asBool(a.is_flagged, `Answer ${i + 1} marked`),
    };
    if (!isBlank(a.client_saved_at)) {
      const at = new Date(String(a.client_saved_at));
      if (Number.isNaN(at.getTime())) throw badRequest(`Answer ${i + 1} has an invalid save time.`);
      out.client_saved_at = at.toISOString();
    }
    return out;
  });
}

/** Small free-form details about an event (how long the page was hidden, and so on). */
export function parseEventMeta(v: unknown): Record<string, unknown> {
  if (isBlank(v)) return {};
  const meta = asObject(v, "meta");
  const keys = Object.keys(meta);
  if (keys.length > 10) throw badRequest("meta has too many fields.");
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (!/^[a-z][a-z0-9_]{0,39}$/.test(key)) throw badRequest(`meta field ${key} is not allowed.`);
    const value = meta[key];
    if (typeof value === "string") out[key] = value.slice(0, 200);
    else if (typeof value === "number" || typeof value === "boolean") out[key] = value;
    else throw badRequest(`meta field ${key} has a value that is not allowed.`);
  }
  return out;
}

export function parseEventType(v: unknown): (typeof SESSION_EVENT_TYPES)[number] {
  return asEnum(v, "event_type", SESSION_EVENT_TYPES);
}

export function parseReason(v: unknown): (typeof SUBMIT_REASONS)[number] {
  return asEnum(v, "reason", SUBMIT_REASONS);
}
