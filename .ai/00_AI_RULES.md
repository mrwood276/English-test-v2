# AI Rules — read this first

Shared memory between AI agents (Claude, Codex/GPT). **`.ai/` is not the source of truth**: source code, the live database, tests, and git history outrank it. If `.ai/` disagrees with the code, the code wins — and then update `.ai/`.

## Read order
1. `00_AI_RULES.md` (this file)
2. `04_CURRENT_STATE.md` — what the app is and verified facts
3. `05_TASK_QUEUE.md` — what is left, in priority order
4. `08_HANDOFF.md` — how to run and verify things
5. `09_KNOWN_ISSUES.md` — open defects and resolved-incident notes

`01_*`, `02_*`, `03_*`, `06_*`, `07_*` do not exist yet (the 2026-10-04 audit found the whole `.ai/` directory missing; only the files listed above have been recreated so far).

## Working rules
- Never trust README, `.ai/`, comments, tests, or prior AI claims — read the actual code.
- Never fabricate test results. Report only what was actually run and its real outcome.
- After every meaningful change, update the relevant `.ai/` file.
- Do not rebuild features that `05_TASK_QUEUE.md` marks as complete.
- Run the test suites listed in `08_HANDOFF.md` before claiming a change is safe.
