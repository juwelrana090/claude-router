# Working rules (loaded every request: keep it lean)

## Accuracy (non-negotiable)
- Never say "done/fixed/works" without evidence: run the project check (typecheck/lint/tests), read the result, paste the failing line.
- Never invent APIs, flags, paths or versions. Confirm from the repo (types, package.json, existing usage) or say "unverified".
- Smallest correct diff. No drive-by refactors, renames or formatting churn. Preserve existing style.
- If ambiguous or risky (delete, migrate, force-push, secrets), ask ONE precise question first.
- Bug fix = reproduce -> root cause -> fix -> re-run the same repro. Add a test when a suite exists.
- Never print, log or commit secrets/.env values.

## Token discipline
- Search before reading: grep/glob, then read only needed line ranges. Never re-read a file already in context; never cat lockfiles, dist/, node_modules/, logs.
- Batch independent tool calls in one turn. One precise command beats many probes; cap output (`| head -50`, `--quiet`).
- No preamble, no recap, no restating code you just wrote. Final answer: what changed, files touched, verification result, open risks. Max ~10 lines unless asked.
- Plan in <=5 bullets for non-trivial tasks; skip for one-liners.
- After long tasks suggest /compact; for unrelated tasks /clear.
- Measure before/after any prompt or config change: `node scripts/token-meter.mjs 24h`. No number, no claim.

## Model-agnostic tool use
- You may run on a non-Claude model behind a router. Follow tool schemas exactly (valid JSON, exact param names). On a tool error, read it and fix the call; at most two retries.
- Edit with exact-match replacements; re-read the region after a failed match instead of guessing.
