import { asArray, asBool, asEnum, asInt, asNumber, asObject, asPlain, asString, asUuid, optional } from "../_shared/validate.ts";
import { badRequest } from "../_shared/errors.ts";
import { ACCESS_CODE_PATTERN, normalizeAccessCode } from "../_shared/codes.ts";

export const EXAM_STATUSES = ["draft", "open", "closed"] as const;
export const AVAILABILITY_MODES = ["manual", "scheduled"] as const;
export const LATE_START_POLICIES = ["full_duration", "cut_at_end"] as const;
export const SELECTION_MODES = ["manual", "auto"] as const;
export const RESULT_VISIBILITIES = ["none", "score", "score_and_review"] as const;
export const ESSAY_PENDING_DISPLAYS = ["hide_score", "show_partial"] as const;
export const SORTS = ["newest", "oldest", "status", "title"] as const;

const isBlank = (v: unknown) => v === undefined || v === null || (typeof v === "string" && v.trim() === "");

/** Timestamp the database accepts; must parse as a date. */
export function asTimestamp(v: unknown, path: string): string {
  if (typeof v !== "string" || v.trim() === "") throw badRequest(`${path} is required.`);
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw badRequest(`${path} is not a valid date and time.`);
  return d.toISOString();
}

/** A code the teacher typed: cleaned, checked against the length/character rules. */
export function asAccessCode(v: unknown, path: string): string {
  const code = normalizeAccessCode(asString(v, path, { min: 4, max: 12 }));
  if (!ACCESS_CODE_PATTERN.test(code)) {
    throw badRequest(`${path} must be 4 to 12 letters and digits, without spaces.`);
  }
  return code;
}

/** One question row of the manual selection. */
export function parseExamQuestions(v: unknown): { question_id: string; weight: number }[] {
  return asArray(v, "Questions", { max: 200 }).map((raw, i) => {
    const q = asObject(raw, `Question ${i + 1}`);
    return {
      question_id: asUuid(q.question_id, `Question ${i + 1} id`),
      weight: isBlank(q.weight) ? 1 : asNumber(q.weight, `Question ${i + 1} points`, { min: 0.01, max: 100 }),
    };
  });
}

/** The auto-selection filter: class label, topic, difficulty, plus how many to draw. */
function parseAutoFilter(raw: unknown): Record<string, unknown> {
  const f = asObject(raw ?? {}, "Selection filter");
  const out: Record<string, unknown> = {};
  if (!isBlank(f.class_label)) out.class_label = asPlain(f.class_label, "Class label", { max: 40 });
  if (!isBlank(f.topic)) out.topic = asPlain(f.topic, "Topic", { max: 120 });
  if (!isBlank(f.difficulty)) out.difficulty = asEnum(f.difficulty, "Difficulty", ["easy", "medium", "hots"] as const);
  if (Object.keys(out).length === 0) throw badRequest("Selection filter needs at least a class, topic, or difficulty to pick from.");
  return out;
}

/** An exam from the editor, cleaned and shaped for public.save_exam. */
export function parseExamInput(b: Record<string, unknown>): { id: string | undefined; payload: Record<string, unknown> } {
  const id = optional(b.id, (v) => asUuid(v, "id"));
  const availabilityMode = isBlank(b.availability_mode) ? "manual" : asEnum(b.availability_mode, "Availability", AVAILABILITY_MODES);
  const selectionMode = isBlank(b.selection_mode) ? "manual" : asEnum(b.selection_mode, "Selection", SELECTION_MODES);

  const scheduled = availabilityMode === "scheduled";
  const startsAt = scheduled ? asTimestamp(b.starts_at, "Opening time") : optional(b.starts_at, (v) => asTimestamp(v, "Opening time")) ?? null;
  const endsAt = scheduled ? asTimestamp(b.ends_at, "Closing time") : optional(b.ends_at, (v) => asTimestamp(v, "Closing time")) ?? null;
  if (scheduled && startsAt && endsAt && new Date(endsAt) <= new Date(startsAt)) {
    throw badRequest("Closing time must be after the opening time.");
  }

  const questions = parseExamQuestions(b.questions ?? []);

  const autoFilter = selectionMode === "auto" ? parseAutoFilter(b.auto_filter) : null;

  const tabWarn = isBlank(b.tab_switch_warn_limit) ? 1 : asInt(b.tab_switch_warn_limit, "Warn limit", { min: 1, max: 50 });
  const tabFlag = isBlank(b.tab_switch_flag_limit) ? 3 : asInt(b.tab_switch_flag_limit, "Flag limit", { min: 1, max: 50 });
  const tabSubmit = isBlank(b.tab_switch_autosubmit_limit) ? 5 : asInt(b.tab_switch_autosubmit_limit, "Auto-submit limit", { min: 1, max: 50 });
  if (!(tabWarn <= tabFlag && tabFlag <= tabSubmit)) {
    throw badRequest("The tab-switch limits must grow: warn, then flag, then auto-submit.");
  }

  const payload: Record<string, unknown> = {
    title: asPlain(b.title, "Title", { min: 1, max: 120 }),
    description: isBlank(b.description) ? null : asString(b.description, "Description", { max: 2000 }),
    status: isBlank(b.status) ? "draft" : asEnum(b.status, "Status", EXAM_STATUSES),
    duration_minutes: asInt(b.duration_minutes, "Duration", { min: 1, max: 300 }),
    passing_grade: isBlank(b.passing_grade) ? 0 : asNumber(b.passing_grade, "Passing grade", { min: 0, max: 100 }),
    availability_mode: availabilityMode,
    starts_at: startsAt,
    ends_at: endsAt,
    late_start_policy: isBlank(b.late_start_policy) ? "full_duration" : asEnum(b.late_start_policy, "Late-start policy", LATE_START_POLICIES),
    access_code: asAccessCode(b.access_code, "Test code"),
    selection_mode: selectionMode,
    auto_filter: autoFilter,
    pool_size: selectionMode === "auto" ? asInt(b.pool_size, "How many questions", { min: 1, max: 200 }) : null,
    draw_per_student: selectionMode === "auto" ? asBool(b.draw_per_student, "Draw again for each student") : false,
    questions,
    randomize_questions: asBool(b.randomize_questions ?? false, "Shuffle question order"),
    randomize_options: asBool(b.randomize_options ?? false, "Shuffle answer choices"),
    result_visibility: isBlank(b.result_visibility) ? "none" : asEnum(b.result_visibility, "Result visibility", RESULT_VISIBILITIES),
    essay_pending_display: isBlank(b.essay_pending_display) ? "hide_score" : asEnum(b.essay_pending_display, "Essay pending display", ESSAY_PENDING_DISPLAYS),
    tab_switch_warn_limit: tabWarn,
    tab_switch_flag_limit: tabFlag,
    tab_switch_autosubmit_limit: tabSubmit,
    is_template: asBool(b.is_template ?? false, "Template flag"),
  };
  return { id, payload };
}

/** Filters for the exam list. Blank means "no filter". */
export function parseListFilters(b: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!isBlank(b.q)) out.q = asString(b.q, "Search", { max: 120 });
  if (!isBlank(b.status)) out.status = asEnum(b.status, "Status", EXAM_STATUSES);
  if (!isBlank(b.sort)) out.sort = asEnum(b.sort, "Sort", SORTS);
  if (b.template_only !== undefined) out.template_only = asBool(b.template_only, "Templates");
  if (b.page !== undefined) out.page = asInt(b.page, "Page", { min: 1, max: 100000 });
  if (b.page_size !== undefined) out.page_size = asInt(b.page_size, "Page size", { min: 1, max: 100 });
  return out;
}

/** One SQL server error message as a friendly 400 for the browser. */
export function rethrowValidation(err: unknown): never {
  throw err instanceof Error ? badRequest(err.message) : badRequest("The exam could not be saved.");
}
