import { asArray, asBool, asEnum, asInt, asNumber, asObject, asPlain, asString, asUuid, optional } from "../_shared/validate.ts";
import { sanitizeInlineHtml } from "../_shared/text.ts";

export const QUESTION_TYPES = ["multiple_choice", "true_false", "short_answer", "essay"] as const;
export const DIFFICULTIES = ["easy", "medium", "hots"] as const;
export const SORTS = ["newest", "oldest", "difficulty", "body"] as const;
export const USED_FILTERS = ["any", "used", "unused"] as const;

/** File ids from the editor. Absent means "leave the files as they are"; an empty list removes them all. */
const mediaList = (v: unknown): { id: string }[] =>
  asArray(v, "Files", { max: 4 }).map((item, i) => ({ id: asUuid(typeof item === "object" && item !== null ? (item as Record<string, unknown>).id : item, `File ${i + 1}`) }));

const isBlank = (v: unknown) => v === undefined || v === null || (typeof v === "string" && v.trim() === "");

/** Rich text (question, answers, explanation): simple formatting is kept, everything else is removed. */
const rich = (v: unknown, path: string, max: number, min = 0) => sanitizeInlineHtml(asString(v, path, { min, max }));

/** Filters for the question list. Blank means "no filter". */
export function parseListFilters(b: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!isBlank(b.q)) out.q = asString(b.q, "Search", { max: 100 });
  if (!isBlank(b.topic)) out.topic = asPlain(b.topic, "Topic", { max: 120 });
  if (!isBlank(b.difficulty)) out.difficulty = asEnum(b.difficulty, "Difficulty", DIFFICULTIES);
  if (!isBlank(b.type)) out.type = asEnum(b.type, "Type", QUESTION_TYPES);
  if (!isBlank(b.class_label)) out.class_label = asPlain(b.class_label, "Class label", { max: 40 });
  if (b.archived !== undefined) out.archived = asBool(b.archived, "Archived");
  if (!isBlank(b.used)) out.used = asEnum(b.used, "Used", USED_FILTERS);
  if (!isBlank(b.sort)) out.sort = asEnum(b.sort, "Sort", SORTS);
  if (b.page !== undefined) out.page = asInt(b.page, "Page", { min: 1, max: 100000 });
  if (b.page_size !== undefined) out.page_size = asInt(b.page_size, "Page size", { min: 1, max: 100 });
  return out;
}

/** A question from the editor, cleaned and shaped for public.save_question. */
export function parseQuestionInput(b: Record<string, unknown>): { id: string | undefined; payload: Record<string, unknown> } {
  const id = optional(b.id, (v) => asUuid(v, "id"));
  const type = asEnum(b.type, "Question type", QUESTION_TYPES);

  const options = asArray(b.options ?? [], "Answers", { max: 6 }).map((raw, i) => {
    const o = asObject(raw, `Answer ${i + 1}`);
    return { body: rich(o.body, `Answer ${i + 1}`, 1000, 1), is_correct: o.is_correct === undefined ? false : asBool(o.is_correct, `Answer ${i + 1} correct flag`) };
  });

  const acceptedAnswers = asArray(b.accepted_answers ?? [], "Accepted answers", { max: 10 }).map((v, i) => asString(v, `Accepted answer ${i + 1}`, { min: 1, max: 300 }));

  const classLabels = asArray(b.class_labels ?? [], "Class labels", { max: 10 })
    .filter((v) => !isBlank(v))
    .map((v, i) => asPlain(v, `Class label ${i + 1}`, { min: 1, max: 40 }));

  const payload: Record<string, unknown> = {
    type,
    difficulty: isBlank(b.difficulty) ? "medium" : asEnum(b.difficulty, "Difficulty", DIFFICULTIES),
    topic: isBlank(b.topic) ? null : asPlain(b.topic, "Topic", { max: 120 }),
    body: rich(b.body, "The question", 5000, 1),
    explanation: isBlank(b.explanation) ? null : rich(b.explanation, "The explanation", 5000),
    essay_guidance: isBlank(b.essay_guidance) ? null : rich(b.essay_guidance, "The grading guide", 5000),
    weight: isBlank(b.weight) ? 1 : asNumber(b.weight, "Points", { min: 0.01, max: 100 }),
    passage_id: isBlank(b.passage_id) ? null : asUuid(b.passage_id, "Reading text"),
    options,
    accepted_answers: acceptedAnswers,
    class_labels: classLabels,
  };
  if (b.media !== undefined && b.media !== null) payload.media = mediaList(b.media);
  return { id, payload };
}

export function parsePassageInput(b: Record<string, unknown>): { id: string | undefined; payload: Record<string, unknown> } {
  const payload: Record<string, unknown> = {
    title: asPlain(b.title, "Title", { min: 1, max: 200 }),
    body: rich(b.body, "The reading text", 20000, 1),
  };
  if (b.media !== undefined && b.media !== null) payload.media = mediaList(b.media);
  return { id: optional(b.id, (v) => asUuid(v, "id")), payload };
}
