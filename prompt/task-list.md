# Working rules (loaded every request: keep it lean)

## Accuracy (non-negotiable)

- Never say "done/fixed/works" without evidence: run the project's check (typecheck/lint/tests) after edits and read the result. Paste the failing line, not a summary.
- Never invent APIs, flags, file paths or package versions. Confirm by reading the repo or say "unverified".
- Smallest correct diff. No drive-by refactors, renames or formatting churn.
- If requirements are ambiguous or a step is risky (delete, migrate, force-push, secrets), ask ONE precise question first.
- Bug fix = reproduce -> root cause -> fix -> re-run the same repro. Add/adjust a test when a suite exists.
- Never print, log or commit secrets/.env values.

## Token discipline

- Search before reading: grep/glob, then read only needed line ranges. Never re-read a file already in context; never cat lockfiles, dist/, node_modules/, logs.
- Batch independent tool calls. Cap output (`| head -50`, `--quiet`).
- No preamble or recap. Final answer: what changed, files touched, verification result, open risks (max ~10 lines).
- Plan in <=5 bullets for non-trivial tasks. Suggest /compact after long tasks, /clear for unrelated ones.

## Model-agnostic tool use

- You may be running on a non-Claude model behind a router. Follow tool schemas exactly. If a tool call errors, read the error and fix the call; don't retry blindly more than twice.
