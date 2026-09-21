export const TYPES = ["multiple_choice", "true_false", "short_answer", "essay"];
export const DIFFICULTIES = ["easy", "medium", "hots"];
const clean = (v) => String(v ?? "").trim();
const norm = (v) => clean(v).replace(/\s+/g, " ").toLowerCase();

export function validateDraft(draft) {
  const d = { ...draft, row: Number(draft.row) || 1, type: clean(draft.type) || "multiple_choice", difficulty: norm(draft.difficulty) || "medium", body: clean(draft.body), topic: clean(draft.topic) || null, explanation: clean(draft.explanation) || null, essay_guidance: clean(draft.essay_guidance) || null, class_labels: (draft.class_labels || []).map(clean).filter(Boolean), accepted_answers: (draft.accepted_answers || []).map(clean).filter(Boolean), options: (draft.options || []).map((o) => ({ body: clean(o.body), is_correct: Boolean(o.is_correct) })), weight: draft.weight === "" || draft.weight == null ? 1 : Number(draft.weight) };
  const problems = [];
  if (!TYPES.includes(d.type)) problems.push("Question type must be multiple choice, true/false, short answer, or essay.");
  if (!d.body) problems.push("The question is required."); else if (d.body.length > 5000) problems.push("The question must be at most 5000 characters.");
  if (!DIFFICULTIES.includes(d.difficulty)) problems.push("Difficulty must be Easy, Medium, or HOTS.");
  if (!Number.isFinite(d.weight) || d.weight < .01 || d.weight > 100) problems.push("Points must be between 0.01 and 100.");
  if (d.class_labels.length > 10) problems.push("Class labels can have at most 10 items.");
  if (d.type === "multiple_choice" || d.type === "true_false") {
    const min = d.type === "true_false" ? 2 : 2, max = d.type === "true_false" ? 2 : 6;
    if (d.options.length < min || d.options.length > max || d.options.some((o) => !o.body)) problems.push(`Answers need ${min === max ? "exactly" : "between"} ${min}${min === max ? "" : ` and ${max}`} non-empty option${max > 1 ? "s" : ""}.`);
    if (d.options.filter((o) => o.is_correct).length !== 1) problems.push("Choose exactly one correct answer.");
  } else if (d.options.length) problems.push("This question type cannot have options.");
  if (d.type === "short_answer" && (!d.accepted_answers.length || d.accepted_answers.length > 10)) problems.push("Short answers need 1 to 10 accepted answers.");
  if (d.type !== "short_answer" && d.accepted_answers.length) problems.push("Only short answers can have accepted answers.");
  return { draft: d, problems };
}

export { clean, norm };
