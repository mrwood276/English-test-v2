/**
 * The PDF class summary's header needs a school name (DEC-033), but nothing in the schema holds one yet —
 * `app_settings` is an empty key/value table reserved for future settings, and adding a teacher-facing
 * settings screen just for one string is out of proportion to this export. Kept on this device instead,
 * the same way the student side already keeps its session in `localStorage` (`student/store.js`).
 */
const KEY = "ENGLISH_TEST_V2_TEACHER_SCHOOL_NAME";

/** null means "never set" (so the export can ask once); "" means "asked, and left blank on purpose". */
export function getSchoolName() {
  try {
    // deno-lint-ignore no-window
    return window.localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function setSchoolName(name) {
  try {
    // deno-lint-ignore no-window
    window.localStorage.setItem(KEY, String(name || ""));
  } catch {
    // A private/blocked storage jar just means the prompt reappears next time; not worth failing the export over.
  }
}
