/**
 * Rules for imported questions. They mirror what the server enforces (SQL function public.save_question), so most
 * problems are shown before anything is sent. The server still checks everything again.
 * The text rule (ignore letter case and extra spaces) is the same as backend/functions/_shared/text.ts and
 * SQL public.normalize_text (DEC-005); this copy is only used for comparing rows inside one file.
 */
export const TYPES = ["multiple_choice", "true_false", "short_answer", "essay"];
export const DIFFICULTIES = ["easy", "medium", "hots"];
export const LIMITS = { batch: 200, options: 6, minOptions: 2, accepted: 10, labels: 10, labelLength: 40, body: 5000, option: 1000, acceptedLength: 300, topic: 120 };

export const normalizeText = (t) => String(t ?? "").replace(/\s+/g, " ").trim().toLowerCase();

/** A key that is equal for questions the server would call "the same": same text and the same answers, in any order. */
export function dupKey(body, texts) {
  return normalizeText(body) + "\n" + texts.map(normalizeText).sort().join("\n");
}

/**
 * Problems in a draft question, as friendly messages (empty list = fine).
 * draft: { type, body, options:[{body,is_correct}], accepted_answers:[text], weight, difficulty, topic, class_labels:[text] }
 */
export function validateDraft(d) {
  const problems = [];
  const body = String(d.body ?? "").trim();
  if (!body) problems.push("The question is empty.");
  if (body.length > LIMITS.body) problems.push(`The question is too long (at most ${LIMITS.body} characters).`);

  const options = d.options || [];
  if (d.type === "multiple_choice") {
    if (options.length < LIMITS.minOptions || options.length > LIMITS.options) problems.push(`Multiple choice needs between ${LIMITS.minOptions} and ${LIMITS.options} answers.`);
    else {
      if (options.filter((o) => o.is_correct).length !== 1) problems.push("Choose exactly one correct answer.");
      if (new Set(options.map((o) => normalizeText(o.body))).size !== options.length) problems.push("Two answers are the same.");
    }
  } else if (d.type === "true_false") {
    if (options.length !== 2 || options.filter((o) => o.is_correct).length !== 1) problems.push("True or false needs the correct answer (True or False).");
  } else if (d.type === "short_answer") {
    const list = d.accepted_answers || [];
    if (list.length < 1) problems.push("Add at least one accepted answer.");
    else if (list.length > LIMITS.accepted) problems.push(`Use at most ${LIMITS.accepted} accepted answers.`);
    else if (new Set(list.map(normalizeText)).size !== list.length) problems.push("Two accepted answers are the same.");
  } else if (d.type !== "essay") {
    problems.push("Could not tell the question type.");
  }
  for (const o of options) if (String(o.body).length > LIMITS.option) { problems.push(`An answer is too long (at most ${LIMITS.option} characters).`); break; }
  for (const a of d.accepted_answers || []) if (a.length > LIMITS.acceptedLength) { problems.push(`An accepted answer is too long (at most ${LIMITS.acceptedLength} characters).`); break; }

  if (!DIFFICULTIES.includes(d.difficulty)) problems.push("Difficulty must be Easy, Medium, or HOTS.");
  if (!(Number(d.weight) > 0 && Number(d.weight) <= 100)) problems.push("Points must be more than 0 and at most 100.");
  if ((d.topic || "").length > LIMITS.topic) problems.push(`The topic is too long (at most ${LIMITS.topic} characters).`);
  if ((d.class_labels || []).length > LIMITS.labels) problems.push(`Use at most ${LIMITS.labels} class labels.`);
  if ((d.class_labels || []).some((l) => l.length > LIMITS.labelLength)) problems.push(`A class label is too long (at most ${LIMITS.labelLength} characters).`);
  return problems;
}
