Paste this into Claude CLI at the project root. Run `/clear` first.

```
ROLE: Senior full-stack engineer. Be token-efficient: never read whole large files, never read node_modules, lockfiles, dist, .git, or logs. Use grep/glob and read files in ranges of 150 lines or fewer. Do not restate code you already showed. Keep replies short.

PROJECT: "claude-router" (zip contents are in the current directory). It is a local router/proxy so that Claude CLI in VS Code only needs a MODEL switch, and the PROVIDER changes automatically.

PHASE 0: Context safety (do first)
1. Create `.claudeignore` (and add the same entries to .gitignore if missing): node_modules, dist, build, .next, coverage, *.log, *.lock, package-lock.json, pnpm-lock.yaml, *.db, data/.
2. Create/refresh `CLAUDE.md` (under 40 lines) containing: stack, run commands, folder map, and the rule "read files in chunks, grep before reading".
3. Update `Notes.md`: a short section explaining the autocompact-thrashing fix (small reads, /clear between phases, /compact at about 60% context, keep tool outputs small).

PHASE 1: Audit and fix (the project does not run)
1. List the tree (max depth 3), read package.json, and identify the stack.
2. Run `npm install`, then `npm run dev`. Read only the tail of the error output. Fix every error (deps, TS/ESM config, imports, ports, missing env handling) until `npm run dev` runs clean. Also run build/typecheck/lint if scripts exist and fix those errors.
3. Print a 10-line state summary: what works, what was broken, what was fixed.

PHASE 2: Provider CRUD (no providers in .env)
- Persist providers in SQLite (better-sqlite3) or a JSON file with an atomic write. Only PORT and ENCRYPTION_SECRET stay in .env.
- Provider fields: id, name, baseUrl, apiKey (encrypted at rest with AES-256-GCM; API responses only return a masked key such as sk-...abcd), protocol (anthropic | openai), enabled, priority, createdAt, and per-model prices (input and output per 1M tokens, editable).
- Model table: id, providerId, modelId, alias, enabled.
- REST API: GET/POST /api/providers, PUT/DELETE /api/providers/:id, and the same for /api/models. Also a "Test connection" endpoint.
- Support unlimited providers (DeepSeek, Z.AI, OpenRouter, OpenCode, custom).

PHASE 3: Automatic switching by model (core feature)
- Expose an Anthropic-compatible endpoint: POST /v1/messages (streaming SSE supported), plus GET /v1/models listing all enabled aliases.
- Claude CLI is configured once with ANTHROPIC_BASE_URL=http://localhost:PORT and a local auth token. From then on the user only changes the model name (`/model deepseek-chat`, `/model glm-4.6`, `/model openrouter/...`) in VS Code.
- The router reads `model` from the request, looks it up in the model table, picks the provider, swaps in that provider's baseUrl and key, and forwards the request. For openai-protocol providers, translate Anthropic request/response and stream formats both ways, including tool_use.
- Fallback: if the provider errors (429/5xx), optionally retry the next provider with the same alias, ordered by priority.
- Unknown model returns a clear error listing the available aliases.
- Add a `scripts/setup-claude-cli` that prints or writes the exact env/settings.json lines for Claude CLI and VS Code.

PHASE 4: Token monitoring
- Record every request from the response `usage` field (input, output, cache read/write). If a provider omits usage, estimate with a tokenizer and mark it "estimated".
- Table usage_log: ts, sessionId, providerId, model, inputTokens, outputTokens, cacheTokens, costUsd, latencyMs, status.
- Session id: use the X-Claude-Code-Session-Id header or metadata.user_id if present, otherwise group by client + 30-minute idle gap.
- Aggregations: today, this month, per provider, per model, per session, plus total cost using the editable prices.
- Live monitoring: SSE endpoint /api/live that pushes per-request and running per-session totals in real time (tokens/min, current session total, current model and provider).
- Optional budget limits: daily and monthly token/cost caps per provider, with a warning or block at the threshold.

PHASE 5: UI (Tailwind CSS only)
Pages: Dashboard, Providers, Models, Usage, Live.
- Dashboard: cards for today, month, top provider, and current session, plus a 30-day line chart and a per-provider bar chart (small chart lib such as recharts or chart.js).
- Providers: table with add, edit, delete, enable toggle, test, and a masked key field. Models: same, grouped by provider.
- Usage: filters by date, provider, model, and session, with CSV export.
- Live: auto-updating session meter and request stream.
- Dark mode, responsive, no other CSS frameworks.

PHASE 6: Wrap up
- Update `Notes.md` with the architecture, API list, Claude CLI setup steps, and how to add a provider through the UI.
- Verify: `npm run dev` runs clean, add a provider through the UI, switch the model in Claude CLI, and confirm a usage row plus live update appears.

RULES
- Work phase by phase. After each phase, run/test it, give a 3-line status, then continue. Do not ask questions unless truly blocked.
- Prefer minimal dependencies. LangChain is NOT needed (it is free/open source, but it adds tokens and complexity for a plain proxy).
- Never print API keys in logs or output.
```

TASK: Add a "Live Task Time / ETA" feature to claude-router. Be token-efficient: use grep first, read files in ranges of 150 lines or fewer, don't re-read files you already changed, keep replies short. Reuse the existing usage_log, SSE /api/live, and Tailwind UI. Add no new heavy dependencies.

GOAL: While a prompt is running, show the user (a) elapsed time, (b) an estimated time remaining until the task finishes, and (c) once done, the final total time.

1. Timing capture (in the proxy, per request)

- Record startedAt, firstTokenAt (TTFT), endedAt, and durationMs.
- While streaming, compute live output tokens/sec.
- Add columns to usage_log: startedAt, firstTokenAt, durationMs, outputTokensPerSec. Write a safe migration that keeps existing data.

2. ETA estimation

- Use history: for the same provider and model, take the last 50 successful requests and compute the median tokens/sec, median TTFT, and median output length.
- Estimated remaining = (expectedOutputTokens - outputTokensSoFar) / currentTokensPerSec, blended 70/30 between the live speed and the historical median speed.
- expectedOutputTokens = the historical median output length for that model, or the request's max_tokens as a cap if there is no history.
- Never show a negative or 0 while the request is still running. Clamp to a minimum of "a few seconds". If there is not enough history, show "estimating..." and a plain elapsed timer.
- The ETA is an estimate, so label it "~" and update it every second.
- For a whole session or multi-step agent task (many requests in a row), also show a session timer: total elapsed since the first request and the average time per request.

3. Live delivery

- Extend the existing SSE /api/live events with: requestId, sessionId, provider, model, elapsedMs, etaMs, outputTokensSoFar, tokensPerSec, status (running | done | error).
- Send an update at least once per second while running, and a final event with the total time when done.

4. UI (Tailwind only)

- Live page and a small header widget on every page: "Running · deepseek-chat · 00:42 elapsed · ~00:18 left · 63 tok/s", with a progress bar (elapsed / (elapsed + eta)).
- When finished: "Done in 01:05", and the widget stays visible for 10 seconds before it collapses.
- Usage page: add columns for duration and tokens/sec, and average duration per provider and per model (day and month).
- Dashboard: cards for "Avg response time" and "Fastest provider".

5. Claude CLI / VS Code visibility

- Add a `scripts/statusline` (or use Claude CLI's statusLine setting) that prints one line: "provider/model · elapsed · ~ETA · session tokens · session cost". Document how to enable it in settings.json.

6. Finish

- Update Notes.md: add a short section for this feature (event fields, ETA formula, statusline setup).
- Verify: run `npm run dev`, send a test prompt through the router, confirm the live timer and ETA update, and that a done event with total time is saved in usage_log. Fix any errors you find.
- Give a 5-line summary of what changed.
