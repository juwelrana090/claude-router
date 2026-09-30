> বাংলা গাইড (সব পেজ, বাটন, env সেটিং ও সমস্যার সমাধান): [GUIDE-BN.md](GUIDE-BN.md)

# claude-router

A local proxy that lets Claude Code route to DeepSeek, Z.AI, OpenRouter and OpenCode.

- **Proxy:** `POST /v1/messages`, `POST /v1/messages/count_tokens`, `GET /v1/models`, `GET /health`
- **Config:** `routes.json` (hot-reloaded) + `.env` (key values only)
- **Monitoring + management UI:** `http://127.0.0.1:<port>/ui`

---

## Quick start

```bash
npm install
cp .env.example .env      # fill in ROUTER_KEY and your provider keys
npm run build
npm start
```

Then set `ANTHROPIC_BASE_URL=http://127.0.0.1:21450` and `ANTHROPIC_AUTH_TOKEN=<ROUTER_KEY>`
in `~/.claude/settings.json`. The **Settings** tab in the UI generates that exact snippet
for you.

---

## The UI

```bash
npm start
# open http://127.0.0.1:21450/ui and paste your ROUTER_KEY
```

Five tabs:

| Tab | What it does |
|---|---|
| **Live** | What is serving requests *right now* (in-flight banner with elapsed timers), provider health cards, and the last 200 requests with latency, tokens, cost and failover reasons. |
| **Providers** | Add / edit / delete providers. Nested key manager (add, replace, remove, masked values, cooldowns). Enable/disable a provider without deleting it. |
| **Models** | Add / edit / delete models, pin a key, set the fallback chain, and **Test** a connection (the only action that spends tokens). |
| **Settings** | `defaultModel` and the `opus` / `sonnet` / `haiku` alias mapping, plus a copy-paste env snippet for `~/.claude/settings.json`. |
| **Usage** | 1h / 24h / 7d totals by model and provider, cache-hit ratio, cost and an inline-SVG chart, read straight from `logs/usage.jsonl`. |

The UI is a single self-contained HTML file (`src/ui/index.html`, copied to `dist/ui/` on
build). No bundler, no framework, no CDN, no external requests.

### Cost safety

- Every read path is local: `GET` endpoints and the live SSE stream **never** call an
  upstream provider. The only exception is the explicit **Test** button
  (`POST /admin/models/:alias/test`), which requires a confirm dialog and sends exactly one
  request with `max_tokens: 1`. Test calls are not recorded in `logs/usage.jsonl`.
- Monitoring hooks on the proxy path are O(1), allocation-light and wrapped in `try/catch`,
  so a bug in the live tracking can never fail a `/v1/messages` request.

### Security

- The server binds `127.0.0.1` only.
- Every `/admin/*` call requires `ROUTER_KEY` in the `Authorization: Bearer …` or
  `x-api-key` header — **never** in the URL.
- Requests whose `Host` header is not `127.0.0.1:<port>` / `localhost:<port>` get `403`
  (DNS-rebinding defence).
- Cross-origin state-changing requests (`POST` / `PUT` / `DELETE`) get `403` unless the
  `Origin` is the router itself. No CORS headers are ever sent.
- The UI keeps your key in `sessionStorage` only — never `localStorage`, never a cookie.
- The UI is served with a strict CSP (`default-src 'none'`, no external origins), and every
  rendered value goes through `textContent` / `esc()` — no `innerHTML` with untrusted data.

---

## How key handling works

- `routes.json` stores **env var names only** (`"keys": ["DEEPSEEK_KEY_1"]`). Key values
  live in `.env` and nowhere else.
- The API and the UI **never return a key value**. They return `configured: true|false` and
  the last 4 characters. Adding or replacing a key writes the value to `.env` and applies it
  to `process.env` immediately, so **a new key works on the very next request with no
  restart**.
- Key values are never written to `routes.json` and never logged.
- Keys are sticky per session (hash of the session seed) so the provider's prompt cache stays
  warm. Failover only happens on a real error: `401`, `402`, `403`, `429` or `5xx` → next key
  → next model in the fallback chain. Cooldowns live in memory (429 uses `retry-after`,
  capped at 5 min; `5xx` 15 s; auth errors 10 min) and can be cleared from the UI.
- Removing a key deletes its line from `.env`, unsets the variable and drops it from
  `routes.json`. If a model pins that key, the delete is refused with the list of pinning
  models until you confirm the cascade.

## Backups and restore

Every write to `routes.json` or `.env` takes a timestamped backup first, keeping the **last 5**
of each in `backups/`:

```
backups/routes.json-2026-09-29T13-45-00-000Z.bak
backups/.env-2026-09-29T13-45-02-000Z.bak
```

To restore, stop the router, copy a `.bak` over the live file, and start again:

```bash
cp backups/routes.json-<timestamp>.bak routes.json
cp backups/.env-<timestamp>.bak .env
npm start
```

Writes are atomic (temp file in the same directory → `fsync` → `rename`), so killing the
process mid-write can never leave a truncated or half-written config.

### Concurrent edits

`GET /admin/snapshot` (and every list endpoint) returns a `version` — a hash of
`routes.json`. Writes must send it back; if the file changed in the meantime the server
answers `409` with the current version and nothing is written. The UI shows this as
"the file changed on disk — press Revert to reload, then retry".

---

## API reference

All endpoints require the router key.

| Method | Path | Notes |
|---|---|---|
| GET | `/admin/snapshot` | Full state: providers, models, in-flight, recent, counters, cooldowns, `version` |
| GET | `/admin/events` | SSE. 1 Hz snapshot + event-driven start/finish/failover. Max 5 clients; falls back to `/admin/snapshot` |
| GET/POST | `/admin/providers` | list / create |
| GET/PUT/DELETE | `/admin/providers/:name` | DELETE needs `?cascade=1` when models use it |
| POST | `/admin/providers/:name/keys` | `{envName, value}` — add or replace |
| DELETE | `/admin/providers/:name/keys/:envName` | removes the `.env` line too |
| POST | `/admin/providers/:name/enable\|disable` | `disabled` providers are skipped by failover |
| GET/POST | `/admin/models` | list / create |
| GET/PUT/DELETE | `/admin/models/:alias` | DELETE needs `?cascade=1` when referenced |
| POST | `/admin/models/:alias/test` | `{confirm:true}` — the only endpoint that calls an upstream |
| GET/PUT | `/admin/settings` | `defaultModel`, `aliases.{opus,sonnet,haiku}` |
| POST | `/admin/keys/:envName/reset-cooldown` | |
| GET | `/admin/usage/summary?range=1h\|24h\|7d` | streams `logs/usage.jsonl`, tolerates corrupt lines |
| GET | `/admin/status`, `/admin/usage` | legacy endpoints, unchanged |

Validation errors come back as `400` with a per-field list:

```json
{ "errors": [{ "field": "baseURL", "message": "must use https (http is only allowed for localhost)" }] }
```

Delete conflicts come back as `409` with exactly what blocks them:

```json
{ "blockedBy": [{ "type": "model", "name": "ds-pro" }],
  "hint": "Repeat with ?cascade=1 to delete those models and clean every reference." }
```

---

## Development

```bash
npm run check        # tsc --noEmit
npm run smoke        # 12 proxy regression tests (mock upstreams, offline)
npm run smoke:admin  # 156 admin/UI API tests (mock upstreams, offline)
npm run smoke:all    # both
```

`npm run build` runs `tsc` and then copies `src/ui/index.html` to `dist/ui/index.html`.

Source layout:

```
src/index.ts    server + proxy (the hot path)
src/config.ts   env, config shape, atomic writes, backups, .env editing, validation
src/routing.ts  model/key resolution and request shaping shared by proxy and admin
src/live.ts     in-memory live state: in-flight, recent ring, cooldowns, counters, SSE hub
src/admin.ts    /admin/* handlers
src/ui/         the single-file UI
```

---

## 🧠 Claude AI Development System

This project uses a shared Claude Code memory system in `.claude/`

### First time setup
```bash
npm install -g @anthropic-ai/claude-code
claude
```
Then add your name to `.claude/settings.local.json`:
```json
{ "developerName": "Your Name Here" }
```
Then run `/r-memory-scan` to build your memory.

### Daily workflow
```
/r-start              → load memory, see project status
/r-todo               → see all pending tasks
/r-pickup             → pick up a task to work on
/r-task [desc]        → execute any task
/r-plan [feature]     → plan a big feature before coding
/r-fix [desc]         → diagnose and fix a bug
/r-done               → mark current task as complete
/r-end                → end of day summary
```

### Team rules
- Commit all `.claude/` changes after tasks
- Only `settings.local.json` and `tasks/eod/` are personal/gitignored
- Add tasks for teammates with `/r-add-task`
- Update module memory after touching any module
