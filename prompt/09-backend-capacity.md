# 09 — Backend: real paging, model-level API key, daily limits, context-window safety for failover

**Run after 01–08 (your current tree).** Node server only. Then run `10-web-history-keys-limits-settings.md`.

## What this adds and why

1. **History paging that cannot skip or repeat rows.** `GET /admin/requests` accepts `offset` (plus `limit`), returns the true `total`, and sorts by `ended_at DESC, id DESC`. Before, only a time cursor existed and rows that finished in the same millisecond could be skipped.
2. **Paste an API key from the model form.** `POST/PUT /admin/models` accepts `newKey: { value, envName? }`. In ONE version-checked save it adds the key to the provider, writes it to `.env`, and pins the model to it. Validation refuses keyless providers, keys under 4 characters and names owned by another provider; a failed save creates nothing. Secrets are never returned by any endpoint.
3. **Daily limits per provider** (`dailyRequests`, `dailyTokens`, both optional) counted from the history since local midnight. When today's usage reaches the limit the router **skips that provider before calling it** and moves down the fallback list, with the reason in the request's route trace (`daily request limit reached (3 of 3 today)`). Provider views expose `today`, the limits and `budgetReason`. This is the "automatic switch when a provider runs out" without waiting for the provider to refuse.
4. **Per-model `contextWindow`** (optional). A fallback model often has a smaller window than the one you picked. When a route declares one and the prompt is over 90% of it, the router first clears old tool output for **that route only** (remembered per session and per route so the route sees identical text every request and its cache keeps working), and if it still cannot fit it skips the route with a reason instead of sending a request the provider would reject. Tokens saved are recorded as `guard_saved`.
5. `GET /admin/system` also returns `root` (the repo folder) and `statusline` (full path of `scripts/statusline.mjs`) so the UI can build a correct `settings.json`.

Limits of what I can promise: the token estimate is ~3.5 characters per token, so windows are matched with 10% headroom; daily counts are for requests the router saw; concurrent requests can overshoot a limit slightly. Nothing here can make a provider cheaper by itself; it prevents failed or oversized requests and keeps the cache-friendly behaviour when switching.

## How to work (read this first)

- This file is **complete**. Do not open, search or read any other file or folder. For a diff, open only that one file.
- Apply each diff from the repo root with `git apply --ignore-whitespace --whitespace=nowarn <file.patch>` (save the block to a `.patch` file first) or edit by hand: `-` lines removed, `+` lines added, the rest is context. If a hunk already looks like the `+` version, skip it and say so.
- Existing files use Windows line endings (CRLF); keep them. No refactors, no renames, no formatting changes.
- Do **not** touch the user's VS Code settings or `~/.claude/settings.json`. Never print, log or commit `.env` values.
- Finish by running the verification commands and paste their **real output**.

## Steps

### Step 1 — Create these new files

### `src/capacity.ts` — NEW file

````ts
import type { ModelCfg, ProviderCfg } from "./config";
import { applyGuard, estimateTokens, readConfig } from "./contextGuard";
import { providerToday } from "./history";

const fmt = (n: number): string =>
  n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(n);

/**
 * Proactive failover: if a provider has a daily request or token limit and today's usage already
 * reached it, say so (the router then skips that route instead of waiting for the provider to refuse).
 */
export function budgetReason(name: string, p: ProviderCfg): string | null {
  if (!p.dailyRequests && !p.dailyTokens) return null;
  const t = providerToday(name);
  if (p.dailyRequests && t.requests >= p.dailyRequests) {
    return `daily request limit reached (${t.requests} of ${p.dailyRequests} today)`;
  }
  if (p.dailyTokens && t.tokens >= p.dailyTokens) {
    return `daily token budget reached (${fmt(t.tokens)} of ${fmt(p.dailyTokens)} today)`;
  }
  return null;
}

export interface Fit {
  body: Record<string, unknown>;
  /** Tokens removed from the prompt so it fits this route's window. */
  saved: number;
  /** Set when the prompt cannot fit even after clearing: the route must be skipped. */
  skip?: string;
  note?: string;
}

/**
 * Multi-provider safety net: a fallback model often has a smaller context window than the model you
 * picked. When a route declares `contextWindow`, an oversized prompt is first shrunk by clearing old tool
 * output (remembered per session AND per route, so that route sees identical text on every request and its
 * cache keeps working; the main route is untouched). If it still does not fit, the route is skipped with a
 * reason instead of sending a request that the provider would reject.
 */
export function fitToWindow(body: Record<string, unknown>, m: ModelCfg, sessionId: string, route: string): Fit {
  if (!m.contextWindow) return { body, saved: 0 };
  const limit = Math.floor(m.contextWindow * 0.9); // the token estimate is rough: keep 10% headroom
  const est = estimateTokens(body);
  if (est <= limit) return { body, saved: 0 };
  const base = readConfig();
  const g = applyGuard(body, `${sessionId}|fit|${route}`, {
    ...base, mode: "on", highTokens: limit, lowTokens: Math.floor(m.contextWindow * 0.6),
  });
  if (g.result.afterTokens > limit || g.body === body) {
    return { body, saved: 0, skip: `prompt ~${fmt(est)} tokens does not fit the ${fmt(m.contextWindow)} window, even after clearing old tool output` };
  }
  return { body: g.body as Record<string, unknown>, saved: g.result.saved, note: `trimmed ~${fmt(g.result.saved)} tokens to fit the ${fmt(m.contextWindow)} window` };
}
````

### `scripts/capacity-smoke.mjs` — NEW file

````js
// Offline test: history paging, daily limits, context-window fit, pasting a key on a model.
// Run: npm run build && node scripts/capacity-smoke.mjs
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, "..", "dist", "index.js");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "router-capacity-"));
const PORT = 21992;

// mock upstream: records the last body per key, always answers 200
const seen = {};
const mock = http.createServer((req, res) => {
  let data = "";
  req.on("data", (c) => (data += c));
  req.on("end", () => {
    const key = req.headers["x-api-key"] || String(req.headers.authorization || "").replace("Bearer ", "");
    seen[key] = { bytes: data.length, body: data };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ type: "message", content: [{ type: "text", text: "ok" }], usage: { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 0 } }));
  });
});
await new Promise((r) => mock.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${mock.address().port}`;

fs.writeFileSync(path.join(home, "routes.json"), JSON.stringify({
  defaultModel: "big",
  aliases: {},
  providers: {
    a: { baseURL: base, auth: "bearer", keys: ["A_KEY_1"], dailyRequests: 3 },
    b: { baseURL: base, auth: "bearer", keys: ["B_KEY_1"], dailyTokens: 10000 },
    c: { baseURL: base, auth: "bearer", keys: ["C_KEY_1"] },
    k: { baseURL: base, auth: "bearer", keys: [] },
    loc: { baseURL: base, auth: "none", keys: [] },
  },
  models: {
    lim: { provider: "a", model: "a-up", key: "A_KEY_1", fallback: ["big"] },
    tok: { provider: "b", model: "b-up", key: "B_KEY_1", fallback: ["big"] },
    small: { provider: "c", model: "small-up", key: "C_KEY_1", contextWindow: 20000, fallback: ["big"] },
    tiny: { provider: "c", model: "tiny-up", key: "C_KEY_1", contextWindow: 5000, fallback: ["big"] },
    big: { provider: "c", model: "big-up", key: "C_KEY_1" },
  },
}));
fs.writeFileSync(path.join(home, ".env"), `ROUTER_PORT=${PORT}\nROUTER_KEY="secret-router"\nA_KEY_1=K-A\nB_KEY_1=K-B\nC_KEY_1=K-C\n`);

const child = spawn(process.execPath, [dist], { env: { ...process.env, ROUTER_HOME: home }, stdio: "pipe" });
await new Promise((r) => setTimeout(r, 1300));
const R = `http://127.0.0.1:${PORT}`;
const H = { "content-type": "application/json", "x-api-key": "secret-router", origin: R };
const post = (model, body = {}) => fetch(R + "/v1/messages", { method: "POST", headers: H, body: JSON.stringify({ model, max_tokens: 50, messages: [{ role: "user", content: "hi" }], ...body }) });
const admin = (p, init = {}) => fetch(R + p, { ...init, headers: { ...H, ...(init.headers || {}) } });
const version = async () => (await (await admin("/admin/models")).json()).version;
const settle = () => new Promise((r) => setTimeout(r, 250));
let fails = 0;
const t = (n, ok, x = "") => { console.log((ok ? "PASS " : "FAIL ") + n + (x ? "  " + x : "")); if (!ok) fails++; };

// big tool-output transcript (~60K tokens)
const transcript = (pairs, chars = 4000) => {
  const messages = [{ role: "user", content: [{ type: "text", text: "go" }] }];
  for (let i = 0; i < pairs; i++) {
    messages.push({ role: "assistant", content: [{ type: "tool_use", id: "t" + i, name: "Read", input: { i } }] });
    messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: "t" + i, content: "z".repeat(chars) }] });
  }
  return { messages, metadata: { user_id: "cap-session" } };
};

// ---------- 1. history paging: no overlap, no gaps, even with identical timestamps
for (let i = 0; i < 37; i++) { const r = await post("big"); await r.text(); }
await settle();
const all = [];
let total = 0;
for (let off = 0; off < 60; off += 10) {
  const j = await (await admin(`/admin/requests?limit=10&offset=${off}`)).json();
  total = j.total;
  all.push(...j.rows.map((x) => x.id));
  if (off === 30) t("page 4 (offset 30) reports hasMore correctly", j.hasMore === (total > 40));
}
t("paging covers every request exactly once", all.length === total && new Set(all).size === total, `total=${total}, collected=${all.length}, unique=${new Set(all).size}`);
const beyond = await (await admin(`/admin/requests?limit=10&offset=${total + 50}`)).json();
t("page past the end is empty, total still correct", beyond.rows.length === 0 && beyond.total === total && beyond.hasMore === false);
const s1 = await (await admin(`/admin/requests?limit=5&offset=0&q=big`)).json();
t("search + paging work together", s1.total > 0 && s1.rows.length === 5);

// ---------- 2. daily request limit: proactive skip, real reason
for (let i = 0; i < 3; i++) { const r = await post("lim"); await r.text(); }
await settle();
let r = await post("lim");
const txt = await r.text();
await settle();
let rows = (await (await admin("/admin/requests?limit=3")).json()).rows;
const skip = rows[0].trace.find((x) => x.route === "lim");
t("daily request limit reached: route skipped before hitting the provider", skip?.outcome === "skipped" && /daily request limit reached \(3 of 3 today\)/.test(skip.detail ?? ""), skip?.detail);
t("... and the fallback answered", rows[0].alias === "big" && r.status === 200);
const provs = (await (await admin("/admin/providers")).json()).providers;
const pa = provs.find((p) => p.name === "a");
t("provider view shows limit, usage today and the reason", pa.dailyRequests === 3 && pa.today.requests === 3 && /daily request limit/.test(pa.budgetReason ?? ""), JSON.stringify(pa.today));

// ---------- 3. daily token budget
r = await post("tok"); await r.text(); await settle(); // 1500 tokens used
for (let i = 0; i < 8; i++) { const x = await post("tok"); await x.text(); }
await settle();
r = await post("tok"); await r.text(); await settle();
rows = (await (await admin("/admin/requests?limit=2")).json()).rows;
const sk2 = rows[0].trace.find((x) => x.route === "tok");
t("daily token budget reached: skipped with the numbers", sk2?.outcome === "skipped" && /daily token budget reached/.test(sk2.detail ?? ""), sk2?.detail);
// raising the limit re-enables it immediately
let v = await version();
let pr = await admin("/admin/providers/b", { method: "PUT", body: JSON.stringify({ version: v, dailyTokens: 1000000 }) });
t("provider limit can be raised", pr.status === 200);
r = await post("tok"); await r.text(); await settle();
rows = (await (await admin("/admin/requests?limit=1")).json()).rows;
t("after raising the limit the chosen model answers again", rows[0].alias === "tok");
v = await version();
pr = await admin("/admin/providers/b", { method: "PUT", body: JSON.stringify({ version: v, dailyTokens: null }) });
t("provider limit can be cleared with null", pr.status === 200 && (await pr.json()).provider.dailyTokens === null);
v = await version();
pr = await admin("/admin/providers/b", { method: "PUT", body: JSON.stringify({ version: v, dailyTokens: 5 }) });
t("silly limit rejected with a clear message", pr.status === 400 && /10000/.test(await pr.text()));

// ---------- 4. context-window fit on failover routes
const big = transcript(40); // ~40 * 4000 chars = ~45K tokens
r = await post("small", big); await r.text(); await settle();
rows = (await (await admin("/admin/requests?limit=1")).json()).rows;
const fitted = rows[0];
t("prompt bigger than the window is trimmed, same model answers", fitted.alias === "small" && r.status === 200, `served ${fitted.alias}`);
t("... trace says what was trimmed", fitted.trace.some((x) => x.outcome === "served" && /trimmed ~.* to fit the 20\.0K window/.test(x.detail ?? "")), JSON.stringify(fitted.trace.at(-1)));
t("... and the upstream really got a smaller prompt", seen["K-C"].bytes < JSON.stringify(big).length * 0.6, `${seen["K-C"].bytes} vs ${JSON.stringify(big).length} bytes`);
t("... history records the tokens saved", fitted.guardSaved > 5000, `guardSaved=${fitted.guardSaved}`);
const sentTwice = seen["K-C"].body;
r = await post("small", transcript(41)); await r.text();
const again = seen["K-C"].body;
const cut = sentTwice.lastIndexOf('{"role":"assistant"');
t("same route, next request: identical cleared text (cache-friendly)", again.startsWith(sentTwice.slice(0, Math.min(cut, 20000))));
r = await post("tiny", big); await r.text(); await settle();
rows = (await (await admin("/admin/requests?limit=1")).json()).rows;
const tsk = rows[0].trace.find((x) => x.route === "tiny");
t("window too small even after clearing: route skipped, fallback answers", tsk?.outcome === "skipped" && /does not fit the 5\.0K window/.test(tsk.detail ?? "") && rows[0].alias === "big", tsk?.detail);
r = await post("big", big); await r.text();
t("route without a window is untouched (full prompt)", seen["K-C"].bytes > JSON.stringify(big).length * 0.95);
v = await version();
pr = await admin("/admin/models/big", { method: "PUT", body: JSON.stringify({ version: v, contextWindow: 100 }) });
t("contextWindow below 4096 rejected", pr.status === 400 && /4096/.test(await pr.text()));

// ---------- 5. paste a key straight from the model form
v = await version();
pr = await admin("/admin/models", { method: "POST", body: JSON.stringify({ version: v, alias: "mine", provider: "k", model: "k-up", newKey: { value: "sk-my-own-secret-9999" } }) });
let pj = await pr.json();
t("create model with a pasted key -> 201, pinned to an automatic name", pr.status === 201 && pj.model.key === "K_KEY_1", JSON.stringify({ status: pr.status, key: pj.model?.key }));
t("secret written to .env, never returned by the API", fs.readFileSync(path.join(home, ".env"), "utf8").includes("K_KEY_1=") && !JSON.stringify(pj).includes("sk-my-own-secret-9999"));
const kp = (await (await admin("/admin/providers")).json()).providers.find((p) => p.name === "k");
t("provider now lists the key, configured, last 4 shown", kp.keys.some((k) => k.envName === "K_KEY_1" && k.configured && k.last4 === "9999"));
r = await post("mine"); await r.text();
t("request with the pasted key reaches the upstream with that key", (seen["sk-my-own-secret-9999"]?.bytes ?? 0) > 0);
v = await version();
pr = await admin("/admin/models/mine", { method: "PUT", body: JSON.stringify({ version: v, newKey: { value: "sk-second-secret-7777", envName: "K_SECOND" } }) });
pj = await pr.json();
t("update model with a second pasted key and a chosen name", pr.status === 200 && pj.model.key === "K_SECOND");
v = await version();
pr = await admin("/admin/models", { method: "POST", body: JSON.stringify({ version: v, alias: "bad1", provider: "loc", model: "x", newKey: { value: "abcdefgh" } }) });
t("keyless provider refuses a pasted key", pr.status === 400 && /needs no key/.test(await pr.text()));
pr = await admin("/admin/models", { method: "POST", body: JSON.stringify({ version: v, alias: "bad2", provider: "k", model: "x", newKey: { value: "ab" } }) });
t("too-short key refused", pr.status === 400);
pr = await admin("/admin/models", { method: "POST", body: JSON.stringify({ version: v, alias: "bad3", provider: "k", model: "x", newKey: { value: "abcdefgh", envName: "A_KEY_1" } }) });
t("a name that belongs to another provider is refused", pr.status === 400 && /already belongs/.test(await pr.text()));
const still = (await (await admin("/admin/models")).json()).models.map((m) => m.alias);
t("failed saves created nothing (atomic)", !still.includes("bad1") && !still.includes("bad2") && !still.includes("bad3"));

// ---------- 6. system info for the settings generator
const sys = await (await admin("/admin/system")).json();
t("system info gives repo root and statusline script path", sys.root === home && sys.statusline === path.join(home, "scripts", "statusline.mjs"));

child.kill();
fs.rmSync(home, { recursive: true, force: true });
mock.close();
console.log(fails ? `\n${fails} FAILED` : "\nALL PASSED");
process.exit(fails ? 1 : 0);
````

### Step 2 — Apply these diffs

### `src/config.ts` — contextWindow on models, dailyRequests/dailyTokens on providers (validated, clearable with null)

````diff
--- a/src/config.ts
+++ b/src/config.ts
@@ -41,6 +41,9 @@
   dropBeta?: boolean;
   dropBodyFields?: string[];
   disabled?: boolean;
+  /** Optional daily caps, counted from the request history since local midnight. Unset = unlimited. */
+  dailyRequests?: number;
+  dailyTokens?: number; // fresh input + cache read + cache write + output
 }
 
 export interface ModelCfg {
@@ -48,6 +51,7 @@
   model: string;
   key?: string; // pin this model to one specific key (env var name)
   maxOutputTokens?: number;
+  contextWindow?: number; // the model's real context window in tokens; bigger prompts are trimmed or the route is skipped
   fallback?: string[]; // other router model names, tried in order
   price?: { in: number; out: number; cacheRead?: number; peak?: boolean }; // USD per 1M tokens; peak = provider charges more in its peak hours
 }
@@ -327,8 +331,25 @@
   const disabled =
     body.disabled === undefined ? !!existing?.disabled : body.disabled === true || body.disabled === "true";
 
+  const limit = (field: "dailyRequests" | "dailyTokens", lo: number, hi: number): number | undefined => {
+    const raw = body[field];
+    if (raw === undefined) return existing?.[field];
+    if (raw === null || raw === "") return undefined; // explicit clear
+    const n = typeof raw === "string" ? Number(raw) : raw;
+    if (typeof n !== "number" || !Number.isInteger(n) || n < lo || n > hi) {
+      errors.push({ field, message: `must be a whole number from ${lo} to ${hi} (leave empty for no limit)` });
+      return existing?.[field];
+    }
+    return n;
+  };
+  const dailyRequests = limit("dailyRequests", 1, 100_000_000);
+  const dailyTokens = limit("dailyTokens", 10_000, 1_000_000_000_000);
+
   if (errors.length) throw new ValidationError(errors);
-  return { baseURL, auth, keys: existing?.keys ?? [], dropBeta, dropBodyFields, disabled };
+  const out: ProviderCfg = { baseURL, auth, keys: existing?.keys ?? [], dropBeta, dropBodyFields, disabled };
+  if (dailyRequests !== undefined) out.dailyRequests = dailyRequests;
+  if (dailyTokens !== undefined) out.dailyTokens = dailyTokens;
+  return out;
 }
 
 export function validateModelAlias(raw: unknown): string {
@@ -401,6 +422,18 @@
     }
   }
 
+  let contextWindow = existing?.contextWindow;
+  if (body.contextWindow === null || body.contextWindow === "") {
+    contextWindow = undefined; // explicit clear
+  } else if (body.contextWindow !== undefined) {
+    const n = typeof body.contextWindow === "string" ? Number(body.contextWindow) : body.contextWindow;
+    if (typeof n !== "number" || !Number.isInteger(n) || n < 4096 || n > 10_000_000) {
+      errors.push({ field: "contextWindow", message: "must be a whole number from 4096 to 10000000 (leave empty if unknown)" });
+    } else {
+      contextWindow = n;
+    }
+  }
+
   let key = existing?.key;
   if (body.key !== undefined) {
     const k = body.key === null ? "" : (body.key as unknown as string);
@@ -448,6 +481,7 @@
   const out: ModelCfg = { provider: provider as string, model: (model as string).trim() };
   if (key) out.key = key;
   if (maxOutputTokens !== undefined) out.maxOutputTokens = maxOutputTokens;
+  if (contextWindow !== undefined) out.contextWindow = contextWindow;
   if (fallback?.length) out.fallback = fallback;
   if (price) out.price = price;
   return out;
````

### `src/db.ts` — migration 4: index for the per-provider daily counters

````diff
--- a/src/db.ts
+++ b/src/db.ts
@@ -88,6 +88,8 @@
    ALTER TABLE requests ADD COLUMN requested_model TEXT;
    ALTER TABLE requests ADD COLUMN resolved_via TEXT;
    ALTER TABLE requests ADD COLUMN trace TEXT;`,
+  // 4: fast "today" counters per provider (daily request/token limits)
+  `CREATE INDEX idx_requests_provider_ended ON requests(provider, ended_at);`,
 ];
 
 function migrate(): void {
````

### `src/history.ts` — offset paging, stable ordering, providerToday()

````diff
--- a/src/history.ts
+++ b/src/history.ts
@@ -56,7 +56,7 @@
 });
 
 export interface HistoryQuery {
-  limit?: number; before?: number; status?: "ok" | "error"; alias?: string; provider?: string;
+  limit?: number; offset?: number; before?: number; status?: "ok" | "error"; alias?: string; provider?: string;
   q?: string; minCtx?: number;
 }
 
@@ -77,8 +77,10 @@
   const base = where.length ? `WHERE ${where.join(" AND ")}` : "";
   const total = (db.prepare(`SELECT COUNT(*) AS n FROM requests ${base}`).get(...args) as { n: number }).n;
   const paged = q.before ? `${base ? base + " AND" : "WHERE"} ended_at < ?` : base;
-  const rows = db.prepare(`SELECT * FROM requests ${paged} ORDER BY ended_at DESC LIMIT ?`)
-    .all(...args, ...(q.before ? [q.before] : []), limit + 1) as unknown as Row[];
+  const offset = Math.max(0, Math.floor(q.offset ?? 0));
+  // Stable order: rows that end in the same millisecond are tie-broken by id, so pages never overlap or skip.
+  const rows = db.prepare(`SELECT * FROM requests ${paged} ORDER BY ended_at DESC, id DESC LIMIT ? OFFSET ?`)
+    .all(...args, ...(q.before ? [q.before] : []), limit + 1, offset) as unknown as Row[];
   return { rows: rows.slice(0, limit).map(toRow), hasMore: rows.length > limit, total };
 }
 
@@ -138,6 +140,24 @@
   };
 }
 
+/** Start of "today" on the router's own clock. Daily limits reset at this moment. */
+export function startOfToday(now = Date.now()): number {
+  const d = new Date(now);
+  d.setHours(0, 0, 0, 0);
+  return d.getTime();
+}
+
+const todayStmt = db.prepare(
+  `SELECT COUNT(*) AS n, COALESCE(SUM(in_tokens + out_tokens + cache_read + cache_write), 0) AS t
+     FROM requests WHERE provider = ? AND ended_at >= ? AND status < 400`,
+);
+
+/** What a provider has served since local midnight (successful requests only). */
+export function providerToday(provider: string): { requests: number; tokens: number } {
+  const r = todayStmt.get(provider, startOfToday()) as { n: number; t: number };
+  return { requests: r.n, tokens: r.t };
+}
+
 // ---------- housekeeping ----------
 export function pruneOld(): number {
   const days = Number(getSetting("history.retentionDays"));
````

### `src/index.ts` — skip exhausted providers, fit the prompt to each route's window

````diff
--- a/src/index.ts
+++ b/src/index.ts
@@ -12,6 +12,7 @@
 import * as eta from "./eta";
 import * as live from "./live";
 import { costOf } from "./pricing";
+import { budgetReason, fitToWindow } from "./capacity";
 import { classifyFailure } from "./failure";
 import { getSetting } from "./db";
 import { buildBody, buildHeaders, keyOrder, resolveModel } from "./routing";
@@ -334,6 +335,16 @@
       addTrace({ route: routeName, outcome: "skipped", detail: p ? `provider ${m.provider} is disabled` : `provider ${m.provider} does not exist` });
       continue;
     }
+    const spent = budgetReason(m.provider, p);
+    if (spent) {
+      addTrace({ route: routeName, outcome: "skipped", detail: `${m.provider}: ${spent}` });
+      continue;
+    }
+    const fit = fitToWindow(upstreamBody, m, sessionId, routeName);
+    if (fit.skip) {
+      addTrace({ route: routeName, outcome: "skipped", detail: fit.skip });
+      continue;
+    }
     const keys = keyOrder(p, m, seed);
     if (!keys.length) {
       addTrace({ route: routeName, outcome: "skipped", detail: m.key ? `${m.key} is empty or missing in .env` : `no keys set for provider ${m.provider}` });
@@ -364,7 +375,7 @@
           up = await fetch(`${p.baseURL}/v1/messages`, {
             method: "POST",
             headers: buildHeaders(req, p, keyName),
-            body: buildBody(upstreamBody, m, p),
+            body: buildBody(fit.body, m, p),
             signal: ac.signal,
           });
         } catch (e) {
@@ -404,7 +415,8 @@
         }
 
         live.noteSuccess(keyName);
-        addTrace({ route: routeName, key: keyName, outcome: "served", status: up.status });
+        addTrace({ route: routeName, key: keyName, outcome: "served", status: up.status, detail: fit.note });
+        if (fit.saved > 0 && track) track.guardSaved = (track.guardSaved ?? 0) + fit.saved;
         if (routeName !== alias) console.warn(`[ROUTER] asked "${body.model}" (${alias}) but served by ${routeName}: ${summary()}`);
         return relay(up, res, body, routeName, m, keyName, started, track);
       }
````

### `src/admin.ts` — provider view (limits, today), newKey on model create/update, offset param, system root/statusline

````diff
--- a/src/admin.ts
+++ b/src/admin.ts
@@ -11,6 +11,7 @@
 } from "./config";
 import { DATA_DIR, DB_FILE, SETTING_DEFAULTS, allSettings, db, setSetting } from "./db";
 import { userCount } from "./auth";
+import { budgetReason } from "./capacity";
 import * as history from "./history";
 import {
   MAX_SSE_CLIENTS, RECENT_MAX, addClient, cooldownLeft, coolInfoFor, dropClient, inFlight,
@@ -126,9 +127,48 @@
     models: Object.keys(getCfg().models).filter((a) => getCfg().models[a].provider === name),
     lastUsed: lastUsedProvider(name),
     last5m: providerRollup(name, 5),
+    dailyRequests: p.dailyRequests ?? null,
+    dailyTokens: p.dailyTokens ?? null,
+    today: history.providerToday(name),
+    budgetReason: budgetReason(name, p),
   };
 }
 
+/**
+ * Optional { newKey: { value, envName? } } on model create/update: the secret is added to the provider's
+ * key list, written to .env, and the model is pinned to it, all in ONE version-checked save.
+ */
+function withNewKey(
+  c: Config, body: Record<string, unknown>, providerName: string | undefined,
+): { cfg: Config; body: Record<string, unknown>; env?: Record<string, string>; envName?: string } {
+  if (body.newKey === undefined || body.newKey === null) return { cfg: c, body };
+  const nk = (typeof body.newKey === "object" ? body.newKey : {}) as Record<string, unknown>;
+  const p = providerName ? c.providers[providerName] : undefined;
+  if (!providerName || !p) throw new ValidationError([{ field: "provider", message: "choose a provider before adding a key" }]);
+  if (p.auth === "none") {
+    throw new ValidationError([{ field: "newKey", message: `provider "${providerName}" needs no key (auth: none)` }]);
+  }
+  const value = typeof nk.value === "string" ? nk.value.trim() : "";
+  if (value.length < 4) throw new ValidationError([{ field: "newKey.value", message: "paste the API key (at least 4 characters)" }]);
+  const owner = new Map<string, string>();
+  for (const [pn, pv] of Object.entries(c.providers)) for (const k of pv.keys) owner.set(k, pn);
+  let envName = typeof nk.envName === "string" ? nk.envName.trim() : "";
+  if (envName) {
+    validateEnvName(envName, "newKey.envName");
+    if (owner.has(envName) && owner.get(envName) !== providerName) {
+      throw new ValidationError([{ field: "newKey.envName", message: `"${envName}" already belongs to provider "${owner.get(envName)}"` }]);
+    }
+  } else {
+    const base = providerName.toUpperCase().replace(/[^A-Z0-9]/g, "_");
+    let n = 1;
+    while (owner.has(`${base}_KEY_${n}`)) n++;
+    envName = `${base}_KEY_${n}`;
+  }
+  const keys = p.keys.includes(envName) ? p.keys : [...p.keys, envName];
+  const cfg: Config = { ...c, providers: { ...c.providers, [providerName]: { ...p, keys } } };
+  return { cfg, body: { ...body, key: envName }, env: { [envName]: value }, envName };
+}
+
 function modelView(alias: string, m: ModelCfg) {
   const p = getCfg().providers[m.provider];
   const keyless = p?.auth === "none";
@@ -775,11 +815,16 @@
   const alias = validateModelAlias(body.alias);
   if (c.models[alias]) throw new ValidationError([{ field: "alias", message: `"${alias}" already exists` }]);
   const version = expectVersion(body);
-  const m = validateModelBody(body, c);
-  const next: Config = { ...c, models: { ...c.models, [alias]: m } };
+  const nk = withNewKey(c, body, typeof body.provider === "string" ? body.provider : undefined);
+  const m = validateModelBody(nk.body, nk.cfg);
+  const next: Config = { ...nk.cfg, models: { ...nk.cfg.models, [alias]: m } };
   validateNoCycle(next.models, alias);
   commit(next, version);
-  sendJSON(res, 201, { version: configVersion(), model: modelView(alias, getCfg().models[alias]) });
+  if (nk.env) {
+    commitEnv(nk.env, [], typeof body.envVersion === "string" ? body.envVersion : undefined);
+    resetCooldown(nk.envName as string);
+  }
+  sendJSON(res, 201, { version: configVersion(), envVersion: envVersion(), model: modelView(alias, getCfg().models[alias]) });
 });
 
 on("GET", /^\/admin\/models\/([^/]+)$/, (_req, res, [alias]) => {
@@ -798,11 +843,16 @@
     throw new ValidationError([{ field: "alias", message: "model aliases are immutable; create a new one" }]);
   }
   const version = expectVersion(body);
-  const updated = validateModelBody(body, c, m);
-  const next: Config = { ...c, models: { ...c.models, [alias]: updated } };
+  const nk = withNewKey(c, body, typeof body.provider === "string" ? body.provider : m.provider);
+  const updated = validateModelBody(nk.body, nk.cfg, m);
+  const next: Config = { ...nk.cfg, models: { ...nk.cfg.models, [alias]: updated } };
   validateNoCycle(next.models, alias);
   commit(next, version);
-  sendJSON(res, 200, { version: configVersion(), model: modelView(alias, getCfg().models[alias]) });
+  if (nk.env) {
+    commitEnv(nk.env, [], typeof body.envVersion === "string" ? body.envVersion : undefined);
+    resetCooldown(nk.envName as string);
+  }
+  sendJSON(res, 200, { version: configVersion(), envVersion: envVersion(), model: modelView(alias, getCfg().models[alias]) });
 });
 
 on("DELETE", /^\/admin\/models\/([^/]+)$/, async (req, res, [alias]) => {
@@ -1013,7 +1063,7 @@
   const num = (k: string) => (q.get(k) ? Number(q.get(k)) : undefined);
   const status = q.get("status");
   const out = history.listRequests({
-    limit: num("limit"), before: num("before"),
+    limit: num("limit"), offset: num("offset"), before: num("before"),
     status: status === "ok" || status === "error" ? status : undefined,
     alias: q.get("alias") || undefined, provider: q.get("provider") || undefined,
     q: q.get("q") || undefined, minCtx: num("minCtx"),
@@ -1101,6 +1151,8 @@
     version, node: process.version, platform: `${process.platform}/${process.arch}`, pid: process.pid,
     uptimeSec: Math.round((Date.now() - startedAt) / 1000), port: PORT,
     timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, memoryMb: Math.round(process.memoryUsage().rss / 1048576),
+    root: path.dirname(ROUTES_FILE),
+    statusline: path.join(path.dirname(ROUTES_FILE), "scripts", "statusline.mjs"),
     paths: { routes: ROUTES_FILE, env: ENV_FILE, backups: BACKUP_DIR, database: DB_FILE, dataDir: DATA_DIR, usageLog: LOG_FILE },
     database: { bytes: dbBytes, requests: count("SELECT COUNT(*) AS n FROM requests"), oldestRequestAt: oldest.t, users: userCount() },
     usageLogBytes: logBytes,
````

### `package.json` — npm script smoke:capacity

````diff
--- a/package.json
+++ b/package.json
@@ -13,9 +13,10 @@
     "check": "tsc --noEmit",
     "smoke": "npm run -s build && node scripts/smoke.mjs",
     "smoke:admin": "npm run -s build && node scripts/admin-smoke.mjs",
-    "smoke:all": "npm run -s smoke && npm run -s smoke:admin && npm run -s smoke:guard && npm run -s smoke:routing",
+    "smoke:all": "npm run -s smoke && npm run -s smoke:admin && npm run -s smoke:guard && npm run -s smoke:routing && npm run -s smoke:capacity",
     "smoke:guard": "npm run -s build && node scripts/guard-smoke.mjs",
-    "smoke:routing": "npm run -s build && node scripts/routing-smoke.mjs"
+    "smoke:routing": "npm run -s build && node scripts/routing-smoke.mjs",
+    "smoke:capacity": "npm run -s build && node scripts/capacity-smoke.mjs"
   },
   "license": "ISC",
   "type": "commonjs",
````

## Verify

```bash
npx tsc --noEmit                    # no output
npm run build                       # built
node scripts/smoke.mjs && node scripts/admin-smoke.mjs && node scripts/guard-smoke.mjs && node scripts/routing-smoke.mjs && node scripts/capacity-smoke.mjs   # ALL PASSED x5
```
`capacity-smoke.mjs` has 31 checks through the real router with a mock upstream: paging covers 37 requests exactly once with no overlap; a page past the end is empty; daily request limit skips the provider (3 of 3 today) and the fallback answers; token budget skip; raising or clearing a limit re-enables the provider immediately; an absurd limit is rejected; a 47K-token prompt sent to a 20K-window route is trimmed (upstream received 39 KB instead of 167 KB), the trace and history record it, and the next request keeps identical cleared text; a 5K window that cannot fit is skipped and the fallback answers; a route without a window is untouched; pasting a key creates `K_KEY_1`, writes `.env`, never echoes the secret, the request reaches the upstream with that key; updating with a chosen name works; keyless provider, short key and a name owned by another provider are refused and nothing is half-created; `/admin/system` returns root and statusline path.
