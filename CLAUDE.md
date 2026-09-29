# Working rules (loaded every request: keep it lean)

## Accuracy (non-negotiable)
- Never say "done/fixed/works" without evidence: run the project's check (typecheck/lint/tests) after edits and read the result. Paste the failing line, not a summary.
- Never invent APIs, flags, file paths or package versions. Confirm by reading the repo (types, package.json, existing usage) or say "unverified".
- Smallest correct diff. No drive-by refactors, renames or formatting churn. Preserve existing style.
- If requirements are ambiguous or a step is risky (delete, migrate, force-push, secrets), ask ONE precise question first.
- Bug fix = reproduce -> root cause -> fix -> re-run the same repro. Add/adjust a test when a test suite exists.
- Never print, log or commit secrets/.env values.

## Token discipline
- Search before reading: grep/glob, then read only the needed line ranges. Never re-read a file already in context; never cat lockfiles, dist/, node_modules/, logs.
- Batch independent tool calls in one turn. Prefer one precise command over many probing ones; cap output (`| head -50`, `--quiet`).
- No preamble, no recap of what the user said, no restating code you just wrote. Final answer: what changed, files touched, verification result, open risks. Max ~10 lines unless asked.
- Plan in <=5 bullets for non-trivial tasks; skip the plan for one-line changes.
- After long tasks suggest /compact; for unrelated tasks suggest /clear.

## Model-agnostic tool use
- You may be running on a non-Claude model behind a router. Follow tool schemas exactly (valid JSON, exact parameter names). If a tool call errors, read the error and fix the call; do not retry blindly more than twice.
- Edit with exact-match replacements; re-read the region after a failed match instead of guessing.
