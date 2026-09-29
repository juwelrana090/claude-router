ROLE
You are a senior TypeScript/Node engineer. Extend my existing project "claude-router v2" (a local proxy that lets Claude Code route to DeepSeek, Z.AI, OpenRouter and OpenCode) with a monitoring + management web UI. Work inside the existing repo. Do not rewrite what already works.

EXISTING FACTS (read the code first, do not assume)

- src/index.ts: single-file Node http server, no framework, binds 127.0.0.1, auth via ROUTER_KEY (Bearer or x-api-key).
- routes.json (hot-reloaded by mtime): { defaultModel, aliases, providers{name:{baseURL,auth,keys[env var NAMES],dropBeta?,dropBodyFields?}}, models{alias:{provider,model,key?,maxOutputTokens?,fallback?,price?}} }.
- Secrets live only in .env, referenced by env var name. .env is read once at startup.
- Existing endpoints: /health, /v1/messages, /v1/messages/count_tokens, /v1/models, /admin/status, /admin/usage. Usage is appended to logs/usage.jsonl.
- Key selection is sticky (hash of session seed) to keep provider prompt caches warm. Failover: 429/401/402/403/5xx -> next key -> fallback model. Cooldown map is in memory.
- `npm run check` (tsc --noEmit) and `npm run smoke` (scripts/smoke.mjs, mock upstreams) must keep passing.

GOAL
A UI served by the router itself at http://127.0.0.1:<port>/ui where I can (1) see live which provider/model/key is handling requests right now and (2) fully manage providers, keys and models (Create, Read, Update, Delete) without editing files by hand or restarting.

HARD CONSTRAINTS

1. Zero extra token cost: the UI and monitoring must NEVER call an upstream provider on their own. Only an explicit "Test connection" button may send one request (max_tokens 1, tiny prompt), with a confirm dialog saying it consumes a few tokens.
2. Do not slow or break the proxy path. Monitoring hooks must be O(1), non-blocking, and wrapped so a UI bug can never fail a /v1/messages request.
3. No build step for the UI and no CDN: a single self-contained HTML file (inline CSS+JS, vanilla JS, no frameworks, no external requests), embedded or read from src/ui/index.html and copied to dist on build.
4. Secrets: API key values are write-only. The API and UI never return a full key, only "configured yes/no" and the last 4 characters. Never log key values. Never put key values in routes.json; they go to .env.
5. Security: keep 127.0.0.1 binding. All /admin/\* and /ui-api calls require ROUTER_KEY in a header (never in the URL). Reject requests whose Host header is not 127.0.0.1/localhost:<port> (DNS-rebinding defence). Reject cross-origin state-changing requests (check Origin). No CORS headers. The UI prompts for ROUTER_KEY once and keeps it in sessionStorage only. Escape all rendered strings (no innerHTML with untrusted data).
6. Files are written atomically (write temp file in same dir, fsync, rename) and a timestamped backup of routes.json and .env is kept (last 5) in backups/. Concurrent-edit safety: GET returns a version (mtime/hash); PUT/DELETE must send it and get 409 if stale.
7. Validation before every write (server side, the UI check is only a convenience): provider name /^[a-z0-9][a-z0-9-]{0,31}$/, baseURL must be https (http allowed only for localhost), auth in {bearer,x-api-key,both}, env var names /^[A-Z][A-Z0-9_]{1,63}$/, model alias unique and not colliding with reserved names, maxOutputTokens positive integer, price numbers >= 0, fallback names must exist and must not form a cycle, key pin must belong to the model's provider. Return precise per-field error messages.
8. Referential integrity on delete: refuse to delete a provider used by any model, or a model referenced by aliases, defaultModel or another model's fallback, and list exactly what blocks it. Offer an explicit "delete and clean references" option that requires a confirm dialog and shows what will change.
9. After any successful change: reload routes.json in memory, apply new/changed env vars to process.env immediately (so a new key works with no restart), and clear cooldown for keys that were changed.

BACKEND (add to src/index.ts or split into src/admin.ts if it stays clean)
A. Live tracking (in memory only, ring buffers, no disk I/O on the hot path):

- inFlight: Map<requestId,{alias,provider,upstreamModel,keyName,startedAt,stream,status:"connecting"|"streaming"}> updated in proxyMessages/relay, removed in finally.
- recent: last 200 finished requests {ts,alias,provider,model,key,status,ms,in,out,cacheRead,cacheWrite,cost,failoverFrom?}. Record failovers explicitly (which key/route failed and why).
- lastUsedByProvider / lastUsedByKey timestamps, plus rolling counters for the last 1m / 5m / 1h (requests, errors, tokens).
  B. GET /admin/events: Server-Sent Events stream pushing snapshot diffs every 1s (inFlight, cooldowns, counters) plus event-driven pushes on request start/finish/failover. Cap concurrent SSE clients (e.g. 5) and clean up on close. Provide GET /admin/snapshot as a polling fallback.
  C. CRUD REST API (JSON):
- GET/POST /admin/providers, GET/PUT/DELETE /admin/providers/:name
- POST/DELETE /admin/providers/:name/keys (add key: {envName, value}; replace value; remove key and delete the line from .env; never echo the value)
- GET/POST /admin/models, GET/PUT/DELETE /admin/models/:alias
- GET/PUT /admin/settings (defaultModel, aliases opus/sonnet/haiku)
- POST /admin/keys/:envName/reset-cooldown, POST /admin/providers/:name/enable|disable (add optional "disabled": true to the provider config; disabled providers are skipped by failover and shown greyed out)
- POST /admin/models/:alias/test (the only endpoint that calls upstream; requires body {confirm:true})
- GET /admin/usage/summary?range=1h|24h|7d (aggregate logs/usage.jsonl by alias and provider: requests, in/out/cache tokens, cache-hit ratio, cost if price set, error rate). Stream-read the file, do not load it all in memory; tolerate corrupt lines.
  D. Router core must honour `disabled`, and keep all current behaviour identical when the UI is unused.

UI (single page, dark/light via prefers-color-scheme, responsive, keyboard friendly, no jank)

1. Live tab (default):
   - A "Now running" banner: the provider/model/key currently serving requests (or "idle"), with a pulsing dot per in-flight request, elapsed timer, and streaming/connecting state.
   - Provider cards: name, status (active / idle / cooling down with countdown / disabled / no key), keys count and how many are healthy, requests+errors in last 5 min, last used time.
   - Live request table (recent 200): time, alias -> provider/model, key name, status, latency, in/out tokens, cache read, cost, and a visible badge when a failover happened with the reason (e.g. "429 on OPENROUTER_KEY_1 -> KEY_2").
   - Connection indicator; auto-reconnect SSE with backoff; fall back to polling.
2. Providers tab: table with Add / Edit / Delete. Form fields: name, baseURL, auth mode, dropBeta, dropBodyFields (tag input), disabled. Nested key manager: add key (env var name + secret value in a password field), replace, remove, show masked last-4, health/cooldown, "reset cooldown". Inline validation errors from the server.
3. Models tab: table with Add / Edit / Delete. Fields: alias, provider (select), upstream model string, pinned key (select from that provider) or "pool", maxOutputTokens, price in/out/cacheRead, fallback chain (ordered, drag or up/down buttons). "Test" button with the token-cost confirm. Show a warning if a fallback is a different quality tier.
4. Settings tab: defaultModel, opus/sonnet/haiku alias mapping (dropdowns), and a read-only "Claude Code env snippet" block with a Copy button generating the exact env block for ~/.claude/settings.json from the current config (ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN placeholder, the three default model vars, ANTHROPIC_SMALL_FAST_MODEL).
5. Usage tab: range selector (1h/24h/7d), per-model and per-provider totals, cache-hit ratio, cost, and a simple inline-SVG bar/line chart (no chart library).
6. UX details: toasts for success/error, confirm dialogs for destructive actions, optimistic UI only after server confirms, unsaved-changes guard, loading and empty states.

TESTS (extend scripts/smoke.mjs or add scripts/admin-smoke.mjs; all offline with mock upstreams)

- Auth: 401 without key; 403 on bad Host; 403 on foreign Origin for POST/PUT/DELETE.
- CRUD round trip for provider, key, model: create -> read -> update -> delete, and routes.json/.env on disk match; hot reload works without restart; a newly added key is used by the very next /v1/messages.
- Secrets: no API response, log line or routes.json ever contains a full key value.
- Integrity: deleting a referenced provider/model is refused with the blocking list; cascade delete cleans references; fallback cycle rejected.
- Concurrency: stale version -> 409; atomic write leaves a valid file if the process is killed mid-write (simulate).
- Live: an in-flight streaming request appears in /admin/snapshot while running and moves to recent when done; a forced failover shows up with its reason.
- Zero-cost: assert the mock upstream received no requests from any GET endpoint or from opening SSE; exactly one from a confirmed /test call.
- Regression: existing 12 smoke tests still pass.

PROCESS (follow strictly)

1. Read src/index.ts, routes.json, scripts/smoke.mjs, package.json fully before designing. Summarize your plan in <=10 bullets, then implement.
2. Small, reviewable steps: backend admin API -> tests -> UI. After each step run `npm run check` and the smoke tests and read the actual output.
3. Never claim something works without showing the command and its passing result. If you cannot verify something (e.g. a real provider call), say "unverified" explicitly.
4. No new runtime dependencies. If you believe one is unavoidable, stop and ask me first.
5. Do not touch my real .env values or print them. Use fake keys in tests.
6. Do not refactor unrelated code or change the proxy behaviour.

DELIVERABLES

- Changed/added source files, updated package.json scripts (`npm run smoke`, `npm run smoke:admin`), updated .env.example if needed.
- A short README section: how to open the UI, how key handling works, how backups/restore work.
- Final report (<=15 lines): what was added, files touched, test results, known limitations, anything unverified.

Next Task::
Noted. Token cost and coding quality are the priority.

**What already reduces tokens in v2:**

- Sticky key per session, so the provider's prompt cache stays warm.
- Background requests (Haiku slot) go to a cheap model.
- Lean `CLAUDE.md`, since it is sent with every request.
- `max_tokens` is capped.
- `count_tokens` is answered locally with no upstream cost.
- `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`.
- `usage.jsonl` records cache reads/writes, so savings can be measured.

**Not done yet:** trimming noisy command output, blocking useless file reads, disabling unused MCP tools, capping thinking tokens, and detecting cache-busting prompts. The prompt below covers those.

```
ROLE
You are a token-efficiency and code-quality engineer for a Claude Code setup that runs through my local "claude-router" (routes.json, .env key pools, sticky keys, logs/usage.jsonl, /admin/usage). Goal: cut token usage aggressively WITHOUT lowering code correctness. Quality is a hard gate; cost is the objective.

RULES OF THE TASK
- Measure first, change second, re-measure third. No optimization without a before/after number.
- Never make a change that risks correctness: do not truncate, summarize or rewrite message content in the router. Only allow transforms that are provably lossless or that remove pure noise (e.g. ANSI codes, progress bars, duplicate log lines).
- Do not call any upstream provider unless I approve. Use logs/usage.jsonl and mock/replay data. If real measurements are needed, tell me the exact command to run and what to send back.
- Do not print or store secrets. Do not add runtime dependencies without asking.
- Say "unverified" for anything you could not run.

STEP 1: BASELINE (read-only)
Read logs/usage.jsonl (stream it, tolerate bad lines) and report per model and per provider: requests, avg input tokens, avg output tokens, cache-read ratio = cacheRead / (in + cacheRead + cacheWrite), cost if price is set, and the 10 largest requests. Also read: CLAUDE.md, .claude/settings.json (and ~/.claude/settings.json), .mcp.json, routes.json. Output a table of the top 5 sources of waste ranked by estimated tokens saved per day.

STEP 2: AUDIT CHECKLIST (report each as ok / problem / fix)
A. Prompt cache:
   - Is anything volatile at the START of the prompt (timestamps, random ids, changing file lists) that breaks the cached prefix?
   - Are tool definitions and their order stable between requests?
   - Does failover or key rotation ever switch keys mid-session (cache is per key)? Sticky selection must hold; failover only on real errors.
   - Is cache_control passed through untouched? Do the providers I use actually report cache reads (check cacheRead in the log)? If a provider never shows cache reads, flag it and recommend using it only for short, one-shot tasks.
B. Context bloat:
   - CLAUDE.md size and duplication (target under ~400 tokens; move rare rules into on-demand docs).
   - MCP servers and tools: every enabled tool definition is sent on every request. List them, mark unused ones, recommend disabling.
   - permissions.deny for Read on node_modules/, dist/, build/, .git/, lockfiles, *.min.js, logs/, coverage/, large generated files and binaries.
   - AUTO_COMPACT window: must match the real context size of the model in use; recommend a value per model in routes.json.
C. Output noise (biggest hidden cost):
   - Create quiet wrappers or npm scripts for tests, lint, build and typecheck that print only failures plus a one-line summary (e.g. `npm run -s check 2>&1 | tail -40`), and a PostToolUse/Bash hook or documented command style so full logs never enter context.
   - Recommend commands that cap output: `rg -n --max-count`, `head`, `git diff --stat`, `git diff -U1`.
D. Model tiering (by task, not by mood):
   - Cheap/fast model: exploration, grep-and-summarize, title/background calls, simple renames, docs, commit messages.
   - Strong model: multi-file changes, debugging with unclear root cause, security-sensitive code, migrations, anything where a wrong answer costs more than the tokens saved.
   - Propose the exact opus/sonnet/haiku alias mapping in routes.json and a one-page rule for when I should type /model to switch.
   - Fallbacks only to equal-tier models; never silently to a weaker one for code edits.
E. Thinking and output caps: recommend MAX_THINKING_TOKENS / effort settings and max_tokens per model so simple tasks do not burn reasoning tokens, while keeping full budget for hard tasks.
F. Workflow habits that save tokens: /clear between unrelated tasks, /compact at ~60% context, subagents or a cheap model for repo exploration, asking for a plan in <=5 bullets before big edits, edits as minimal diffs, no re-reading files already in context.

STEP 3: IMPLEMENT ONLY SAFE CHANGES
Apply, in small commits, only changes that are lossless or noise-only:
1. A lean CLAUDE.md rewrite (keep every accuracy rule, remove words, not rules) with a before/after token estimate (chars/3.5).
2. .claude/settings.json: permissions.deny list, env caps, hook that trims verification output, MCP cleanup list (as recommendations if unsure).
3. Router: a cache-health warning in the console and /admin/usage when a model's cache-read ratio is under a threshold after N requests; a "prefix changed" detector that hashes the first 2 KB of system+tools and logs when it changes within a session (metadata only, no content logged).
4. Quiet-output scripts and a docs/TOKEN-RULES.md (max 1 page) I can follow daily.
Do NOT: compress or drop messages in the router, strip tools, lower max_tokens below what tasks need, or change model routing for accuracy-critical aliases without telling me.

STEP 4: QUALITY GATE (must pass before you report success)
- npm run check and npm run smoke pass; show the output.
- Run 5 representative tasks from my repo history (bug fix, small feature, refactor, test writing, explanation) on the old and new setup using replayed or dry-run data where possible; for anything that needs a live model, give me a checklist to run and compare (task, tokens in/out, cache ratio, tests passing yes/no, retries needed).
- If any task got worse in correctness, revert that change and say why.

STEP 5: REPORT (max 20 lines)
- Baseline vs expected numbers (tokens per task, cache ratio, cost) clearly labeled measured or estimated.
- List of changes made, files touched, and the rollback command for each.
- Top 3 remaining opportunities and the risk of each.
- Exactly what you could not verify.
```

**Tip:** run Step 1 before anything else and send me the baseline table. The biggest savings usually come from cache breaks, output noise from test and build logs, and unused MCP tools, not from clever prompt wording.
