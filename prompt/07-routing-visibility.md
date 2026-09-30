# 07 — Routing visibility: see who answered and why, stop silent model switches

**Run after 01–05.** Node server + web UI.

## The problem this fixes

You pick `glm` but `ds-flash` answers. Your own database shows it: 65 recent requests, **all** answered by `ds-flash`, zero by `glm`, and 9 of them flagged as failover at intervals of 64, 87 and 100 seconds. In the old code that is exactly what a **failing Z.ai key** looks like:
1. `glm` fails once (HTTP 429 without a Retry-After header → the router rests the *whole key* for 60 s; HTTP 401/402/403 → 10 minutes).
2. While the key rests, the router **skips `glm` without a word** and uses the next model in glm's fallback list, `ds-flash`. Claude Code gets a normal answer and shows no error. (That is why 56 of the 65 rows have no "failover" flag: nothing was even tried.)
3. After the rest ends, the next request tries `glm` again, fails again, and the cycle repeats.

What the code could not tell you: **why** Z.ai fails, and **what name** VS Code actually sent. I cannot see either from here. This step makes both visible, and fixes the parts that were wrong:

- **History and Live show the truth.** Every request stores what the client asked for (`requested_model`), how the router resolved it (`exact` / `alias` / `default`), which alias it chose, every route it tried (`served` / `skipped` / `failed` / `retry`, with the provider's error text, secrets redacted) and who answered. A red **"asked glm"** tag appears next to the model when a different one answered; **History > Details > Route taken** lists the steps. Requests that fail completely are now recorded too (before, a request that never reached any upstream left no trace).
- **Keys show why they rest** (Providers > Keys > the orange tag), for example `HTTP 429: code 1113: Insufficient balance`.
- **Smarter failure handling.** Rate limits, overload and network blips get up to 2 quick retries on the **same** key before anything is skipped. Balance/quota/permission errors (and 401/402/403) are never retried and rest the key for 10 minutes. Repeated transient failures rest the key for 8 s, 16 s, 32 s ... up to 5 min instead of a flat 60 s.
- **A switch you control**: Settings > Routing > *When the model you picked fails*: `Switch automatically` (as before) or `Stop and show the error` (the router never switches; Claude Code shows the provider's own error). Plus the retry count (0–5).
- **Name matching** is now case-insensitive (`GLM` → `glm`) and every resolution is recorded.
- **Response headers** `x-router-asked`, `x-router-served`, `x-router-failover` when a different model answered; the live widget shows `ds-flash (asked glm)`.

I did **not** verify: which error Z.ai really returns for your key (the new trace will show it on the next request), and what the VS Code extension sends (History > Details > "Client asked for" will show it). What I did verify on exactly this code is listed under Verify.

## How to work (read this first)

- This file is **complete**. Do not open, search or read any other file or folder. For a diff, open only that one file.
- Apply each diff from the repo root with `git apply --ignore-whitespace --whitespace=nowarn <file.patch>` (save the block to a `.patch` file first) or edit by hand: `-` lines removed, `+` lines added, the rest is context. If a hunk already looks like the `+` version, skip it and say so.
- Existing files use Windows line endings (CRLF); keep them. No refactors, no renames, no formatting changes.
- Do **not** touch the user's VS Code settings or `~/.claude/settings.json`. Never print, log or commit `.env` values.
- Finish by running the verification commands and paste their **real output**.

## Steps

### Step 1 — Create these new files

### `src/failure.ts` — NEW file

````ts
/**
 * Turns an upstream failure (HTTP status + body, or a network error) into a decision:
 * how long to rest the key, whether a quick retry on the same key is worth it, and a short,
 * secret-free reason that the UI can show. Retry-After wins when the provider sends one.
 */
export interface Failure {
  kind: "persistent" | "transient";
  /** A quick retry on the same key may succeed (rate limit, overload, network blip). */
  retryable: boolean;
  /** How long to wait before that retry. */
  waitMs: number;
  /** How long to rest the key if it still fails. */
  cooldownMs: number;
  /** "HTTP 429: code 1113: Insufficient balance ..." */
  reason: string;
  snippet: string;
}

const MINUTE = 60_000;
const RATE_LIKE = /rate.?limit|too many requests|concurren|overload|try again|temporar|busy|throttl/i;
const QUOTA_LIKE =
  /balance|insufficient|quota|exhaust|resource package|recharge|top.?up|billing|credit|subscription|usage limit|limit (has been )?reached|has been reached|exceeded|not allowed|not permitted|permission|expired|invalid.{0,20}key|unauthori|forbidden|suspend|disabled|not include|does not include/i;

function redact(s: string): string {
  return s
    .replace(/\b(sk|or|zai|gsk|key)[-_][A-Za-z0-9_-]{8,}\b/gi, "[redacted]")
    .replace(/[A-Za-z0-9_-]{28,}/g, "[redacted]");
}

export function snippetOf(bodyText: string): string {
  let msg = "";
  let code = "";
  try {
    const j = JSON.parse(bodyText);
    msg = String(j?.error?.message ?? j?.message ?? j?.msg ?? (typeof j?.error === "string" ? j.error : "") ?? "");
    const c = j?.error?.code ?? j?.code ?? "";
    code = c === "" || c == null ? "" : String(c);
  } catch {
    msg = bodyText.replace(/<[^>]+>/g, " ");
  }
  const one = redact(`${code ? `code ${code}: ` : ""}${msg}`).replace(/\s+/g, " ").trim();
  return one.length > 160 ? `${one.slice(0, 157)}...` : one;
}

/** `streak` = how many times in a row this key has already failed. */
export function classifyFailure(status: number, retryAfterHeader: string | null, bodyText: string, streak: number): Failure {
  const snippet = snippetOf(bodyText);
  const reason = `HTTP ${status || "network"}${snippet ? `: ${snippet}` : ""}`;
  const ra = Number(retryAfterHeader);
  const retryAfterMs = Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 60 * MINUTE) : 0;
  const base = Number(process.env.ROUTER_RETRY_BASE_MS ?? 1000); // tests shorten this

  const hay = `${snippet} ${bodyText.slice(0, 400)}`;
  const persistent =
    status === 401 || status === 402 || status === 403 ||
    (status === 429 && !RATE_LIKE.test(hay) && QUOTA_LIKE.test(hay));
  if (persistent) {
    return { kind: "persistent", retryable: false, waitMs: 0, cooldownMs: Math.max(retryAfterMs, 10 * MINUTE), reason, snippet };
  }
  // Transient: rate limit, overload, 5xx, network. Rest grows on repeated failures (8s, 16s, 32s ... 5 min).
  const grow = Math.min(8_000 * 2 ** Math.max(0, streak), 5 * MINUTE);
  const cool = status >= 500 || status === 0 ? Math.min(15_000 * 2 ** Math.max(0, streak), 2 * MINUTE) : Math.max(retryAfterMs, grow);
  return {
    kind: "transient",
    retryable: status !== 501 && status !== 505,
    waitMs: retryAfterMs > 0 ? retryAfterMs : base,
    cooldownMs: cool,
    reason,
    snippet,
  };
}
````

### `scripts/routing-smoke.mjs` — NEW file

````js
// Offline test of routing visibility and failover policy. Run: npm run build && node scripts/routing-smoke.mjs
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, "..", "dist", "index.js");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "router-routing-"));
const PORT = 21993;

// ---- mock upstream: behaviour depends on the API key ----
const hits = {};
let rlLeft = 2; // K-RL fails twice, then works
const mock = http.createServer((req, res) => {
  let data = "";
  req.on("data", (c) => (data += c));
  req.on("end", () => {
    const key = req.headers["x-api-key"] || String(req.headers.authorization || "").replace("Bearer ", "");
    hits[key] = (hits[key] ?? 0) + 1;
    const body = JSON.parse(data || "{}");
    if (key === "K-BALANCE") {
      res.writeHead(429, { "content-type": "application/json" });
      return res.end('{"error":{"code":"1113","message":"Insufficient balance or no resource package. Please recharge."}}');
    }
    if (key === "K-RL") {
      if (rlLeft-- > 0) {
        res.writeHead(429, { "content-type": "application/json" });
        return res.end('{"error":{"message":"Rate limit reached for requests"}}');
      }
    }
    if (key === "K-DEAD") { res.writeHead(500); return res.end('{"error":{"message":"boom sk-abcdefghijklmnop1234"}}'); }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ type: "message", content: [{ type: "text", text: "ok from " + body.model }], usage: { input_tokens: 10, output_tokens: 5 } }));
  });
});
await new Promise((r) => mock.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${mock.address().port}`;

fs.writeFileSync(path.join(home, "routes.json"), JSON.stringify({
  defaultModel: "flash",
  aliases: { sonnet: "glm", haiku: "flash" },
  providers: {
    zai: { baseURL: base, auth: "bearer", keys: ["ZAI_KEY_1", "ZAI_RL"] },
    ds: { baseURL: base, auth: "bearer", keys: ["DS_KEY_1"] },
  },
  models: {
    glm: { provider: "zai", model: "glm-up", key: "ZAI_KEY_1", fallback: ["flash"] },
    rl: { provider: "zai", model: "rl-up", key: "ZAI_RL", fallback: ["flash"] },
    flash: { provider: "ds", model: "flash-up", key: "DS_KEY_1" },
    nokey: { provider: "zai", model: "nokey-up", key: "MISSING_KEY", fallback: ["flash"] },
  },
}));
fs.writeFileSync(path.join(home, ".env"),
  `ROUTER_PORT=${PORT}\nROUTER_KEY="secret-router"\nZAI_KEY_1=K-BALANCE\nZAI_RL=K-RL\nDS_KEY_1=K-DS\nROUTER_RETRY_BASE_MS=40\n`);

const child = spawn(process.execPath, [dist], { env: { ...process.env, ROUTER_HOME: home }, stdio: "pipe" });
let log = "";
child.stdout.on("data", (d) => (log += d));
child.stderr.on("data", (d) => (log += d));
await new Promise((r) => setTimeout(r, 1200));

const R = `http://127.0.0.1:${PORT}`;
const H = { "content-type": "application/json", "x-api-key": "secret-router" };
const post = (model, extra = {}) => fetch(R + "/v1/messages", { method: "POST", headers: H, body: JSON.stringify({ model, max_tokens: 50, messages: [{ role: "user", content: "hi" }], ...extra }) });
const admin = (p, init = {}) => fetch(R + p, { ...init, headers: { ...H, ...(init.headers || {}) } });
const history = async () => (await (await admin("/admin/requests?limit=5")).json()).rows;
const settle = () => new Promise((r) => setTimeout(r, 250));
let fails = 0;
const t = (name, ok, extra = "") => { console.log((ok ? "PASS " : "FAIL ") + name + (extra ? "  " + extra : "")); if (!ok) fails++; };

// 1. persistent 429 (balance) -> no pointless retries, served by fallback, loudly
let r = await post("glm");
let txt = await r.text();
await settle();
t("persistent 429: client still gets an answer from the fallback", r.status === 200 && txt.includes("flash-up"));
t("persistent 429: tried the failing key exactly once (no retries on a balance error)", hits["K-BALANCE"] === 1, `hits=${hits["K-BALANCE"]}`);
t("response says who answered instead", r.headers.get("x-router-asked") === "glm" && r.headers.get("x-router-served") === "flash" && /Insufficient balance/.test(r.headers.get("x-router-failover") ?? ""));
let rows = await history();
t("history: asked glm, served flash, reason recorded", rows[0].askedAlias === "glm" && rows[0].alias === "flash" && rows[0].trace.some((x) => x.outcome === "failed" && /Insufficient balance/.test(x.detail ?? "")), JSON.stringify(rows[0].trace.map((x) => x.route + ":" + x.outcome)));
t("history: requested model name and how it resolved", rows[0].requestedModel === "glm" && rows[0].resolvedVia === "exact");

// 2. next request: glm is skipped with the real reason (this is the silent case users hit)
r = await post("glm");
await r.text();
await settle();
rows = await history();
const skipped = rows[0].trace.find((x) => x.route === "glm");
t("while resting: glm skipped, trace explains why", skipped?.outcome === "skipped" && /resting .*Insufficient balance/.test(skipped.detail ?? ""), skipped?.detail);
t("while resting: the failing upstream is NOT hit again", hits["K-BALANCE"] === 1);
const keys = await (await admin("/admin/providers")).json();
const zk = (keys.providers ?? keys).find((p) => p.name === "zai").keys.find((k) => k.envName === "ZAI_KEY_1");
t("key view shows why it is resting", zk.cooling && /Insufficient balance/.test(zk.cooldownReason ?? ""), zk.cooldownReason);

// 3. transient 429 (rate limit): quick retry on the same key, no failover, no cooldown
r = await post("rl");
txt = await r.text();
await settle();
t("transient 429: answered by the SAME model after quick retries", r.status === 200 && txt.includes("rl-up"), `hits=${hits["K-RL"]}`);
t("transient 429: no failover headers", r.headers.get("x-router-served") === null);
rows = await history();
t("transient 429: trace shows the retries", rows[0].alias === "rl" && rows[0].trace.filter((x) => x.outcome === "retry").length === 2);
const zk2 = ((await (await admin("/admin/providers")).json()).providers).find((p) => p.name === "zai").keys.find((k) => k.envName === "ZAI_RL");
t("transient 429: key not put to rest after a successful retry", !zk2.cooling);

// 4. failover OFF: the chosen model answers or you see its real error
let pr = await admin("/admin/app-settings", { method: "PUT", body: JSON.stringify({ settings: { "routing.failover": "off" } }) });
t("setting routing.failover=off accepted", pr.status === 200);
pr = await admin("/admin/app-settings", { method: "PUT", body: JSON.stringify({ settings: { "routing.failover": "sometimes" } }) });
t("invalid failover value rejected", pr.status === 400);
await admin("/admin/keys/ZAI_KEY_1/reset-cooldown", { method: "POST", body: "{}" });
r = await post("glm");
txt = await r.text();
await settle();
t("failover off: client gets the provider's own 429 and message", r.status === 429 && /Insufficient balance/.test(txt), `status ${r.status}`);
r = await post("glm");
txt = await r.text();
t("failover off + key resting: clear 4xx/5xx message that names the reason and the setting", r.status >= 400 && /unavailable/.test(txt) && /Insufficient balance/.test(txt) && /Failover is off/.test(txt), txt.slice(0, 160));
rows = await history();
t("failed requests are in history too (not invisible)", rows[0].status >= 400 && rows[0].askedAlias === "glm");
pr = await admin("/admin/app-settings", { method: "PUT", body: JSON.stringify({ settings: { "routing.failover": "auto", "routing.retries": 0 } }) });
t("retries can be set to 0", pr.status === 200);

// 5. missing key is explained, not silent
r = await post("nokey");
txt = await r.text();
await settle();
rows = await history();
t("missing key: trace says the variable is empty/missing", rows[0].trace.some((x) => x.route === "nokey" && x.outcome === "skipped" && /MISSING_KEY/.test(x.detail ?? "")));

// 6. name resolution is recorded
r = await post("GLM"); await r.text();
r = await post("claude-sonnet-4-5"); await r.text();
r = await post("totally-unknown"); await r.text();
await settle();
const by = Object.fromEntries((await history()).map((x) => [x.requestedModel, x]));
t("GLM (upper case) resolves exactly", by["GLM"]?.resolvedVia === "exact" && by["GLM"]?.askedAlias === "glm");
t("claude-sonnet-4-5 resolves through the aliases map", by["claude-sonnet-4-5"]?.resolvedVia === "alias" && by["claude-sonnet-4-5"]?.askedAlias === "glm");
t("unknown name is recorded as default fallback", by["totally-unknown"]?.resolvedVia === "default");

// 7. secrets in upstream error text never reach headers/history
await admin("/admin/keys/ZAI_KEY_1/reset-cooldown", { method: "POST", body: "{}" });
fs.appendFileSync(path.join(home, ".env"), "ZAI_DEAD=K-DEAD\n");
const cfg = JSON.parse(fs.readFileSync(path.join(home, "routes.json"), "utf8"));
cfg.models.dead = { provider: "zai", model: "dead-up", key: "ZAI_DEAD", fallback: ["flash"] };
cfg.providers.zai.keys.push("ZAI_DEAD");
fs.writeFileSync(path.join(home, "routes.json"), JSON.stringify(cfg));
await new Promise((r) => setTimeout(r, 900));
child.kill();
child.stdout.removeAllListeners();
// restart to pick up the new .env value cleanly
const child2 = spawn(process.execPath, [dist], { env: { ...process.env, ROUTER_HOME: home }, stdio: "pipe" });
await new Promise((r) => setTimeout(r, 1200));
r = await post("dead"); await r.text(); await settle();
const dead = (await history())[0];
const all = JSON.stringify(dead.trace) + (r.headers.get("x-router-failover") ?? "");
t("upstream text containing a key-like token is redacted", /\[redacted\]/.test(all) && !/sk-abcdefghijklmnop1234/.test(all), all.slice(0, 140));
child2.kill();

fs.rmSync(home, { recursive: true, force: true });
mock.close();
console.log(fails ? `\n${fails} FAILED` : "\nALL PASSED");
process.exit(fails ? 1 : 0);
````

### Step 2 — Apply these diffs

### `src/db.ts` — migration 3 (routing trace columns) + settings defaults routing.failover / routing.retries

````diff
--- a/src/db.ts
+++ b/src/db.ts
@@ -83,6 +83,11 @@
    CREATE INDEX idx_guard_created ON guard_cleared(created_at);
    ALTER TABLE requests ADD COLUMN guard_saved INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE requests ADD COLUMN guard_would INTEGER NOT NULL DEFAULT 0;`,
+  // 3: routing visibility (what was asked, how it resolved, every route tried)
+  `ALTER TABLE requests ADD COLUMN asked_alias TEXT;
+   ALTER TABLE requests ADD COLUMN requested_model TEXT;
+   ALTER TABLE requests ADD COLUMN resolved_via TEXT;
+   ALTER TABLE requests ADD COLUMN trace TEXT;`,
 ];
 
 function migrate(): void {
@@ -115,6 +120,8 @@
   "guard.lowTokens": 45_000,
   "guard.keepRecent": 6,
   "guard.minChars": 1200,
+  "routing.failover": "auto",
+  "routing.retries": 2,
 } as const;
 export type SettingKey = keyof typeof SETTING_DEFAULTS;
 
````

### `src/live.ts` — cooldown reasons, failure streaks, trace type

````diff
--- a/src/live.ts
+++ b/src/live.ts
@@ -1,5 +1,14 @@
 import type { ServerResponse } from "node:http";
 
+/** One step of a request's journey through the route chain (shown in History). */
+export interface TraceStep {
+  route: string;
+  key?: string;
+  outcome: "served" | "skipped" | "failed" | "retry";
+  status?: number;
+  detail?: string;
+}
+
 export interface InFlight {
   id: string;
   alias: string;
@@ -23,6 +32,11 @@
   // context guard numbers for the history row
   guardSaved?: number;
   guardWould?: number;
+  // routing visibility: what the client asked for and how the router got to the route that answered
+  askedAlias?: string;
+  requestedModel?: string;
+  resolvedVia?: string;
+  trace?: TraceStep[];
 }
 
 export interface RecentEntry {
@@ -50,16 +64,30 @@
 
 // ---------- cooldowns (key env name -> epoch ms when it frees up) ----------
 export const cooldown = new Map<string, number>();
+/** Why a key is resting (shown in the Keys dialog and in request traces). */
+export const coolInfo = new Map<string, { status: number; reason: string; at: number }>();
+const failStreak = new Map<string, number>();
 
-export function cool(key: string, ms: number): void {
+export function cool(key: string, ms: number, info?: { status: number; reason: string }): void {
   cooldown.set(key, Date.now() + ms);
+  if (info) coolInfo.set(key, { ...info, at: Date.now() });
+  failStreak.set(key, (failStreak.get(key) ?? 0) + 1);
+}
+
+export const streakOf = (key: string): number => failStreak.get(key) ?? 0;
+export function noteSuccess(key: string): void {
+  failStreak.delete(key);
+  coolInfo.delete(key);
 }
+export const coolInfoFor = (key: string) => (cooldownLeft(key) > 0 ? coolInfo.get(key) : undefined);
 
 export function cooldownLeft(key: string): number {
   return Math.max(0, (cooldown.get(key) ?? 0) - Date.now());
 }
 
 export function resetCooldown(key: string): boolean {
+  failStreak.delete(key);
+  coolInfo.delete(key);
   return cooldown.delete(key);
 }
 
````

### `src/routing.ts` — resolveModel (records how a name resolved, case-insensitive)

````diff
--- a/src/routing.ts
+++ b/src/routing.ts
@@ -6,20 +6,28 @@
   return Array.isArray(v) ? v.join(",") : v;
 }
 
-export function resolveAlias(c: Config, raw: string): string | undefined {
+export type ResolvedVia = "exact" | "alias" | "default";
+
+/** How a client-sent model name became a router alias, and why (shown in History). */
+export function resolveModel(c: Config, raw: string): { alias: string; via: ResolvedVia } | undefined {
   const name = raw.replace(/\[[^\]]*\]$/, "").trim(); // "sonnet[1m]" -> "sonnet"
-  if (c.models[name]) return name;
+  if (c.models[name]) return { alias: name, via: "exact" };
   const lower = name.toLowerCase();
+  if (c.models[lower]) return { alias: lower, via: "exact" }; // "GLM" -> "glm"
   for (const [needle, target] of Object.entries(c.aliases ?? {})) {
-    if (lower.includes(needle) && c.models[target]) return target;
+    if (lower.includes(needle) && c.models[target]) return { alias: target, via: "alias" };
   }
   if (c.defaultModel && c.models[c.defaultModel]) {
     console.warn(`[ROUTER] unknown model "${raw}" -> default "${c.defaultModel}"`);
-    return c.defaultModel;
+    return { alias: c.defaultModel, via: "default" };
   }
   return undefined;
 }
 
+export function resolveAlias(c: Config, raw: string): string | undefined {
+  return resolveModel(c, raw)?.alias;
+}
+
 // Sticky key choice keeps the provider-side prompt cache warm (cache is per account/key).
 /** Pseudo key name for providers that need no key (auth "none", e.g. a local Ollama). */
 export const KEYLESS_PREFIX = "(no key) ";
````

### `src/index.ts` — route loop: trace, retry-in-place, smart cooldowns, failover on/off, clear errors, headers

````diff
--- a/src/index.ts
+++ b/src/index.ts
@@ -12,7 +12,9 @@
 import * as eta from "./eta";
 import * as live from "./live";
 import { costOf } from "./pricing";
-import { buildBody, buildHeaders, keyOrder, resolveAlias } from "./routing";
+import { classifyFailure } from "./failure";
+import { getSetting } from "./db";
+import { buildBody, buildHeaders, keyOrder, resolveModel } from "./routing";
 
 if (!ROUTER_KEY) {
   console.error("ROUTER_KEY is missing in .env - refusing to start without auth.");
@@ -149,6 +151,12 @@
   const ct = up.headers.get("content-type");
   if (ct) res.setHeader("content-type", ct);
   res.setHeader("x-router-route", `${m.provider}/${m.model}`);
+  if (track?.askedAlias && track.askedAlias !== alias) {
+    const clean = (v: string) => v.replace(/[^\x20-\x7E]/g, "?").slice(0, 300);
+    res.setHeader("x-router-asked", clean(track.askedAlias));
+    res.setHeader("x-router-served", clean(alias));
+    res.setHeader("x-router-failover", clean((track.trace ?? []).filter((t) => t.outcome !== "served").map((t) => `${t.route}: ${t.detail ?? t.outcome}`).join(" | ")));
+  }
 
   const streamed = !!(body.stream && up.body);
   let firstTokenAt = 0;
@@ -247,16 +255,26 @@
   }
 
   const c: Config = getCfg();
-  const alias = resolveAlias(c, body.model);
-  if (!alias) {
+  const resolved = resolveModel(c, body.model);
+  if (!resolved) {
     return fail(res, 400, "invalid_request_error",
       `Unknown model "${body.model}". Available: ${Object.keys(c.models).join(", ")}`);
   }
+  const alias = resolved.alias;
 
   const meta = body.metadata as { user_id?: string } | undefined;
   const seed = String(meta?.user_id ?? JSON.stringify(body.system ?? "").slice(0, 4000));
   const sessionId = "u-" + crypto.createHash("sha1").update(seed).digest("hex").slice(0, 12);
-  const chain = [alias, ...(c.models[alias].fallback ?? [])].filter((n) => c.models[n]);
+  // "off" = the model you picked answers or you see its real error; "auto" = move down the fallback list.
+  const failoverOn = (getSetting("routing.failover") as string) !== "off";
+  const retries = Number(getSetting("routing.retries"));
+  const chain = (failoverOn ? [alias, ...(c.models[alias].fallback ?? [])] : [alias]).filter((n) => c.models[n]);
+  const trace: live.TraceStep[] = [];
+  const addTrace = (t: live.TraceStep): void => { if (trace.length < 14) trace.push(t); };
+  const summary = (): string =>
+    trace.filter((t) => t.outcome !== "served")
+      .map((t) => `${t.route}${t.key ? ` (${t.key})` : ""}: ${t.outcome === "retry" ? "retried, " : ""}${t.detail ?? t.outcome}`)
+      .join(" | ");
 
   // Context guard: clear OLD tool outputs (remembered per session) before the prompt goes upstream.
   const guard = applyGuard(body, sessionId);
@@ -269,44 +287,70 @@
   res.on("close", () => ac.abort());
 
   let lastStatus = 503;
-  let lastText = JSON.stringify({
-    type: "error",
-    error: { type: "api_error", message: "No usable upstream key (missing or cooling down)" },
-  });
+  let lastText = "";
 
   // One tracked request for the whole chain: failovers keep the same requestId
   // and the terminal eta event is emitted exactly once, after the last route.
   let track: live.InFlight | undefined;
+  const begin = (routeName: string, keyName: string): live.InFlight => {
+    const m = c.models[routeName];
+    const t = live.startRequest({
+      alias: routeName,
+      provider: m.provider,
+      model: m.model,
+      keyName,
+      startedAt: Date.now(),
+      stream: !!body.stream,
+      status: "connecting",
+      sessionId,
+      maxTokens: Number(body.max_tokens) || 0,
+      clientStartedAt: started,
+    });
+    eta.begin(t);
+    t.guardSaved = guard.result.saved;
+    t.guardWould = guard.result.would;
+    t.askedAlias = alias;
+    t.requestedModel = String(body.model);
+    t.resolvedVia = resolved.via;
+    t.trace = trace;
+    return t;
+  };
+  const sleep = (ms: number) => new Promise<void>((r) => {
+    const t = setTimeout(r, ms);
+    ac.signal.addEventListener("abort", () => { clearTimeout(t); r(); }, { once: true });
+  });
+  const aborted = (routeName: string, keyName: string): void => {
+    const m = c.models[routeName];
+    live.finishRequest(track!.id, {
+      alias: routeName, provider: m.provider, model: m.model, key: keyName, status: 499,
+      ms: Date.now() - started, ...ZERO(), cost: 0, sessionId,
+    });
+  };
 
   for (const routeName of chain) {
     const m = c.models[routeName];
     const p: ProviderCfg | undefined = c.providers[m.provider];
     if (!p || p.disabled) {
-      if (p?.disabled) console.warn(`[ROUTER] provider ${m.provider} is disabled, skipping`);
+      addTrace({ route: routeName, outcome: "skipped", detail: p ? `provider ${m.provider} is disabled` : `provider ${m.provider} does not exist` });
+      continue;
+    }
+    const keys = keyOrder(p, m, seed);
+    if (!keys.length) {
+      addTrace({ route: routeName, outcome: "skipped", detail: m.key ? `${m.key} is empty or missing in .env` : `no keys set for provider ${m.provider}` });
       continue;
     }
 
-    for (const keyName of keyOrder(p, m, seed)) {
-      if ((live.cooldown.get(keyName) ?? 0) > Date.now()) continue;
+    for (const keyName of keys) {
+      const left = live.cooldownLeft(keyName);
+      if (left > 0) {
+        const info = live.coolInfoFor(keyName);
+        addTrace({ route: routeName, key: keyName, outcome: "skipped", status: info?.status, detail: `resting ${Math.ceil(left / 1000)}s after ${info?.reason ?? "an earlier failure"}` });
+        continue;
+      }
 
       console.log(`[ROUTER] ${body.model} -> ${routeName} (${m.provider}/${m.model}) key=${keyName}`);
-      if (!track) {
-        track = live.startRequest({
-          alias: routeName,
-          provider: m.provider,
-          model: m.model,
-          keyName,
-          startedAt: Date.now(),
-          stream: !!body.stream,
-          status: "connecting",
-          sessionId,
-          maxTokens: Number(body.max_tokens) || 0,
-          clientStartedAt: started,
-        });
-        eta.begin(track);
-        track.guardSaved = guard.result.saved;
-        track.guardWould = guard.result.would;
-      } else if (track.alias !== routeName || track.keyName !== keyName) {
+      if (!track) track = begin(routeName, keyName);
+      else if (track.alias !== routeName || track.keyName !== keyName) {
         // Same logical request on a new route/key: keep the live frames accurate.
         track.alias = routeName;
         track.provider = m.provider;
@@ -314,56 +358,85 @@
         track.keyName = keyName;
       }
 
-      let up: Response;
-      try {
-        up = await fetch(`${p.baseURL}/v1/messages`, {
-          method: "POST",
-          headers: buildHeaders(req, p, keyName),
-          body: buildBody(upstreamBody, m, p),
-          signal: ac.signal,
-        });
-      } catch (e) {
-        if (ac.signal.aborted) {
-          live.finishRequest(track.id, {
-            alias: routeName, provider: m.provider, model: m.model, key: keyName, status: 499,
-            ms: Date.now() - started, ...ZERO(), cost: 0, sessionId,
+      for (let attempt = 0; ; attempt++) {
+        let up: Response;
+        try {
+          up = await fetch(`${p.baseURL}/v1/messages`, {
+            method: "POST",
+            headers: buildHeaders(req, p, keyName),
+            body: buildBody(upstreamBody, m, p),
+            signal: ac.signal,
           });
-          return;
+        } catch (e) {
+          if (ac.signal.aborted) { aborted(routeName, keyName); return; }
+          const f = classifyFailure(0, null, (e as Error).message, live.streakOf(keyName));
+          if (f.retryable && attempt < retries && live.streakOf(keyName) === 0) {
+            addTrace({ route: routeName, key: keyName, outcome: "retry", detail: `${f.snippet} (waiting ${f.waitMs} ms)` });
+            await sleep(f.waitMs);
+            if (ac.signal.aborted) { aborted(routeName, keyName); return; }
+            continue;
+          }
+          live.cool(keyName, f.cooldownMs, { status: 0, reason: f.reason });
+          addTrace({ route: routeName, key: keyName, outcome: "failed", detail: `unreachable: ${f.snippet}` });
+          live.setFailover(track.id, { from: keyName, status: 0, reason: `unreachable: ${f.snippet}` });
+          lastStatus = 502;
+          lastText = JSON.stringify({ type: "error", error: { type: "api_error", message: `Upstream unreachable: ${f.snippet}` } });
+          break;
         }
-        live.cool(keyName, 15_000);
-        live.setFailover(track.id, { from: keyName, status: 0, reason: `unreachable: ${(e as Error).message}` });
-        lastStatus = 502;
-        lastText = JSON.stringify({ type: "error", error: { type: "api_error", message: `Upstream unreachable: ${(e as Error).message}` } });
-        continue;
-      }
 
-      if ([401, 402, 403, 429].includes(up.status) || up.status >= 500) {
-        const retryAfter = Number(up.headers.get("retry-after")) * 1000;
-        const ms = up.status === 429 ? Math.min(retryAfter || 60_000, 300_000)
-          : up.status >= 500 ? 15_000 : 600_000;
-        live.cool(keyName, ms);
-        lastStatus = up.status;
-        try { lastText = await up.text(); } catch { /* error body unreadable -> keep the last one */ }
-        live.setFailover(track.id, { from: keyName, status: up.status, reason: `${up.status} on ${keyName}` });
-        console.warn(`[ROUTER] ${keyName} -> ${up.status}, cooling ${Math.round(ms / 1000)}s, trying next`);
-        continue;
-      }
+        if ([401, 402, 403, 429].includes(up.status) || up.status >= 500) {
+          let text = "";
+          try { text = await up.text(); } catch { /* error body unreadable */ }
+          const f = classifyFailure(up.status, up.headers.get("retry-after"), text, live.streakOf(keyName));
+          if (f.retryable && f.kind === "transient" && attempt < retries && f.waitMs <= 10_000 && live.streakOf(keyName) === 0) {
+            addTrace({ route: routeName, key: keyName, outcome: "retry", status: up.status, detail: `${f.snippet || `HTTP ${up.status}`} (waiting ${f.waitMs} ms)` });
+            await sleep(f.waitMs);
+            if (ac.signal.aborted) { aborted(routeName, keyName); return; }
+            continue;
+          }
+          live.cool(keyName, f.cooldownMs, { status: up.status, reason: f.reason });
+          lastStatus = up.status;
+          lastText = text || lastText;
+          addTrace({ route: routeName, key: keyName, outcome: "failed", status: up.status, detail: f.snippet || `HTTP ${up.status}` });
+          live.setFailover(track.id, { from: keyName, status: up.status, reason: f.reason });
+          console.warn(`[ROUTER] ${keyName} -> ${f.reason}; resting ${Math.round(f.cooldownMs / 1000)}s${failoverOn ? ", trying next" : ", failover is off"}`);
+          break;
+        }
 
-      return relay(up, res, body, routeName, m, keyName, started, track);
+        live.noteSuccess(keyName);
+        addTrace({ route: routeName, key: keyName, outcome: "served", status: up.status });
+        if (routeName !== alias) console.warn(`[ROUTER] asked "${body.model}" (${alias}) but served by ${routeName}: ${summary()}`);
+        return relay(up, res, body, routeName, m, keyName, started, track);
+      }
     }
   }
 
-  // The whole chain failed: close the tracked request exactly once, after every
-  // route had its chance (failover successes never reach this terminal frame).
-  if (track && live.inFlight.has(track.id)) {
+  // The whole chain failed (or nothing could even be tried): record it and say exactly why.
+  const why = summary() || "no route could be tried";
+  const note = failoverOn ? "" : " Failover is off (Settings > Routing).";
+  if (!track) {
+    const first = c.models[chain[0] ?? alias];
+    track = begin(chain[0] ?? alias, first?.key ?? "-");
+    lastStatus = 503;
+  }
+  let outText = lastText;
+  let isJsonError = false;
+  try { isJsonError = !!JSON.parse(outText)?.error; } catch { /* not JSON */ }
+  if (!isJsonError) {
+    outText = JSON.stringify({
+      type: "error",
+      error: { type: "api_error", message: `Model "${body.model}" (${alias}) is unavailable. ${why}.${note}` },
+    });
+  }
+  if (live.inFlight.has(track.id)) {
     live.finishRequest(track.id, {
       alias: track.alias, provider: track.provider, model: track.model, key: track.keyName, status: lastStatus,
       ms: Date.now() - started, ...ZERO(), cost: 0, sessionId,
     });
   }
-
+  res.setHeader("x-router-trace", why.replace(/[^\x20-\x7E]/g, "?").slice(0, 400));
   res.writeHead(lastStatus, { "content-type": "application/json" });
-  res.end(lastText);
+  res.end(outText);
 }
 
 // ---------- UI ----------
````

### `src/history.ts` — store and return the trace

````diff
--- a/src/history.ts
+++ b/src/history.ts
@@ -8,8 +8,8 @@
 const insert = db.prepare(`INSERT OR REPLACE INTO requests
   (id, session_id, alias, provider, model, key_name, status, stream, failover, started_at, first_token_at,
    ended_at, duration_ms, ttft_ms, in_tokens, out_tokens, cache_read, cache_write, ctx_tokens, cost, tps,
-   guard_saved, guard_would)
-  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
+   guard_saved, guard_would, asked_alias, requested_model, resolved_via, trace)
+  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
 
 /** Called for every finished request, including failures and aborts. Never throws. */
 export function recordFinished(id: string, e: RecentEntry, f?: InFlight): void {
@@ -21,6 +21,8 @@
       e.startedAt ?? e.ts - dur, e.firstTokenAt ?? null, e.ts, dur, e.ttftMs ?? null,
       e.in, e.out, e.cacheRead, e.cacheWrite, e.in + e.cacheRead + e.cacheWrite, e.cost, e.outputTokensPerSec ?? null,
       f?.guardSaved ?? 0, f?.guardWould ?? 0,
+      f?.askedAlias ?? null, f?.requestedModel ?? null, f?.resolvedVia ?? null,
+      f?.trace?.length ? JSON.stringify(f.trace) : null,
     );
   } catch (err) {
     console.warn("[HISTORY] write failed:", (err as Error).message);
@@ -33,6 +35,9 @@
   endedAt: number; durationMs: number | null; ttftMs: number | null; in: number; out: number;
   cacheRead: number; cacheWrite: number; ctx: number; cost: number; tps: number | null;
   guardSaved: number; guardWould: number;
+  /** Alias the client's model name resolved to (what you asked for). `alias` is what answered. */
+  askedAlias: string | null; requestedModel: string | null; resolvedVia: string | null;
+  trace: { route: string; key?: string; outcome: string; status?: number; detail?: string }[];
 }
 
 type Row = Record<string, string | number | null>;
@@ -45,6 +50,9 @@
   in: r.in_tokens as number, out: r.out_tokens as number, cacheRead: r.cache_read as number,
   cacheWrite: r.cache_write as number, ctx: r.ctx_tokens as number, cost: r.cost as number, tps: r.tps as number | null,
   guardSaved: r.guard_saved as number, guardWould: r.guard_would as number,
+  askedAlias: (r.asked_alias as string | null) ?? null, requestedModel: (r.requested_model as string | null) ?? null,
+  resolvedVia: (r.resolved_via as string | null) ?? null,
+  trace: (() => { try { return r.trace ? JSON.parse(r.trace as string) : []; } catch { return []; } })(),
 });
 
 export interface HistoryQuery {
@@ -163,6 +171,7 @@
           j.startedAt ? Date.parse(j.startedAt) : ended - dur, j.firstTokenAt ? Date.parse(j.firstTokenAt) : null,
           ended, dur, j.ttftMs ?? null, j.in ?? 0, j.out ?? 0, j.cacheRead ?? 0, j.cacheWrite ?? 0,
           (j.in ?? 0) + (j.cacheRead ?? 0) + (j.cacheWrite ?? 0), j.cost ?? 0, j.outputTokensPerSec ?? null, 0, 0,
+          null, null, null, null,
         );
         n++;
       } catch { /* skip malformed line */ }
````

### `src/admin.ts` — key resting reason, settings validation

````diff
--- a/src/admin.ts
+++ b/src/admin.ts
@@ -13,7 +13,7 @@
 import { userCount } from "./auth";
 import * as history from "./history";
 import {
-  MAX_SSE_CLIENTS, RECENT_MAX, addClient, cooldownLeft, dropClient, inFlight,
+  MAX_SSE_CLIENTS, RECENT_MAX, addClient, cooldownLeft, coolInfoFor, dropClient, inFlight,
   lastUsedKey, lastUsedProvider, providerRollup, recent, resetCooldown, rollup, sseClientCount,
 } from "./live";
 import { buildHeaders, keyOrder } from "./routing";
@@ -91,6 +91,7 @@
   last4: string;
   cooldownSeconds: number;
   cooling: boolean;
+  cooldownReason: string | null;
   lastUsed?: number;
 }
 
@@ -103,6 +104,7 @@
     last4: v ? v.slice(-4) : "",
     cooldownSeconds: Math.ceil(left / 1000),
     cooling: left > 0,
+    cooldownReason: left > 0 ? (coolInfoFor(envName)?.reason ?? null) : null,
     lastUsed: lastUsedKey(envName),
   };
 }
@@ -1021,6 +1023,7 @@
     running: [...inFlight.values()].map((f) => ({
       id: f.id, alias: f.alias, provider: f.provider, model: f.model, key: f.keyName, startedAt: f.startedAt,
       stream: f.stream, status: f.status, failover: !!f.failover, outSoFar: f.outSoFar ?? 0, tokensPerSec: f.tokensPerSec ?? null,
+      askedAlias: f.askedAlias ?? null,
     })),
   });
 });
@@ -1055,7 +1058,11 @@
     else if (k === "pricing.peakMultiplier") {
       const n = Number(input[k]);
       if (!Number.isFinite(n) || n < 1 || n > 10) errors.push({ field: k, message: "must be a number from 1 to 10" }); else clean[k] = n;
-    } else if (k === "guard.mode") {
+    } else if (k === "routing.failover") {
+      if (input[k] !== "auto" && input[k] !== "off") errors.push({ field: k, message: "must be auto or off" });
+      else clean[k] = input[k];
+    } else if (k === "routing.retries") int(k, 0, 5);
+    else if (k === "guard.mode") {
       if (input[k] !== "off" && input[k] !== "shadow" && input[k] !== "on") errors.push({ field: k, message: "must be off, shadow or on" });
       else clean[k] = input[k];
     } else if (k === "guard.highTokens") int(k, 20_000, 2_000_000);
````

### `src/eta.ts` — asked alias on live frames

````diff
--- a/src/eta.ts
+++ b/src/eta.ts
@@ -116,6 +116,7 @@
     requestId: f.id,
     sessionId: f.sessionId ?? null,
     alias: f.alias,
+    askedAlias: f.askedAlias ?? null,
     provider: f.provider,
     model: f.model,
     status: "running" as const,
@@ -335,6 +336,7 @@
       requestId: f.id,
       sessionId: f.sessionId ?? null,
       alias: f.alias,
+      askedAlias: f.askedAlias ?? null,
       provider: f.provider,
       model: f.model,
       status: "running" as const,
````

### `src/web/src/types.ts` — trace fields

````diff
--- a/src/web/src/types.ts
+++ b/src/web/src/types.ts
@@ -17,6 +17,8 @@
   requestId: string;
   sessionId: string;
   alias: string;
+  /** What the client asked for, when a different model answered (failover). */
+  askedAlias?: string | null;
   provider: string;
   model: string;
   status: EtaStatus;
@@ -235,6 +237,11 @@
   guardSaved: number;
   /** Tokens it would have removed (mode shadow). */
   guardWould: number;
+  /** Alias the client's model name resolved to. `alias` is the route that actually answered. */
+  askedAlias: string | null;
+  requestedModel: string | null;
+  resolvedVia: 'exact' | 'alias' | 'default' | null;
+  trace: { route: string; key?: string; outcome: 'served' | 'skipped' | 'failed' | 'retry'; status?: number; detail?: string }[];
 }
 
 export interface RunningRow {
@@ -249,6 +256,7 @@
   failover: boolean;
   outSoFar: number;
   tokensPerSec: number | null;
+  askedAlias?: string | null;
 }
 
 export interface HistoryResponse {
````

### `src/web/src/appSettings.tsx` — routing settings

````diff
--- a/src/web/src/appSettings.tsx
+++ b/src/web/src/appSettings.tsx
@@ -11,6 +11,8 @@
   'guard.lowTokens': number;
   'guard.keepRecent': number;
   'guard.minChars': number;
+  'routing.failover': 'auto' | 'off';
+  'routing.retries': number;
 }
 
 const DEFAULTS: AppSettings = {
@@ -23,6 +25,8 @@
   'guard.lowTokens': 45_000,
   'guard.keepRecent': 6,
   'guard.minChars': 1200,
+  'routing.failover': 'auto',
+  'routing.retries': 2,
 };
 
 interface Ctx {
````

### `src/web/src/components/RequestTable.tsx` — red 'asked ...' tag

````diff
--- a/src/web/src/components/RequestTable.tsx
+++ b/src/web/src/components/RequestTable.tsx
@@ -3,6 +3,13 @@
 import { fmtCompact, fmtDateTime, fmtExact, fmtMs, fmtPct, fmtTps, fmtUsd } from '../format';
 import type { HistoryRow, RunningRow } from '../types';
 
+/** One sentence: why the model you picked did not answer. */
+export function routeExplanation(r: { askedAlias?: string | null; alias: string; trace?: HistoryRow['trace'] }): string {
+  const bad = (r.trace ?? []).filter((t) => t.outcome === 'failed' || t.outcome === 'skipped');
+  if (!bad.length) return `You asked for ${r.askedAlias}; ${r.alias} answered.`;
+  return `You asked for ${r.askedAlias}, but ${r.alias} answered. ${bad.map((t) => `${t.route}${t.key ? ` (${t.key})` : ''}: ${t.detail ?? t.outcome}`).join(' | ')}`;
+}
+
 export type Row = (HistoryRow & { running?: false }) | (RunningRow & { running: true; ctx?: undefined });
 
 /** One row = one request, from the moment it starts (blue) until it finishes (green/red). */
@@ -31,6 +38,11 @@
         <div style={{ lineHeight: 1.3 }}>
           <Typography.Text strong>{r.alias}</Typography.Text>
           {r.failover && <Tag color="warning" style={{ marginLeft: 6 }}>failover</Tag>}
+          {r.askedAlias && r.askedAlias !== r.alias && (
+            <Tooltip title={routeExplanation(r)}>
+              <Tag color="error" style={{ marginLeft: 6 }}>asked {r.askedAlias}</Tag>
+            </Tooltip>
+          )}
           <div><Typography.Text type="secondary" style={{ fontSize: 12 }}>{r.provider} · {r.model}</Typography.Text></div>
         </div>
       ),
````

### `src/web/src/components/HeaderWidget.tsx` — live widget shows asked model

````diff
--- a/src/web/src/components/HeaderWidget.tsx
+++ b/src/web/src/components/HeaderWidget.tsx
@@ -153,7 +153,7 @@
     const ev = focused.event;
     const elapsed = ev.elapsedMs + Math.max(0, now - focused.recvAt);
     const eta = ev.etaMs;
-    const parts = [`Running - ${ev.alias} - ${fmtClock(elapsed)}`];
+    const parts = [`Running - ${ev.askedAlias && ev.askedAlias !== ev.alias ? `${ev.alias} (asked ${ev.askedAlias})` : ev.alias} - ${fmtClock(elapsed)}`];
     if (eta != null) {
       parts.push(`~${fmtClock(eta)} left`);
       pct = Math.min(100, Math.max(2, (elapsed / (elapsed + eta)) * 100));
````

### `src/web/src/pages/History.tsx` — details: client asked for / route taken

````diff
--- a/src/web/src/pages/History.tsx
+++ b/src/web/src/pages/History.tsx
@@ -128,7 +128,9 @@
             <Descriptions.Item label="Request">{open.id}</Descriptions.Item>
             <Descriptions.Item label="Status">{open.status >= 400 ? <Tag color="error">{open.status}</Tag> : <Tag color="success">{open.status}</Tag>}{open.failover && <Tag color="warning">failover used</Tag>}</Descriptions.Item>
             <Descriptions.Item label="Started">{fmtDateTime(open.startedAt)}</Descriptions.Item>
-            <Descriptions.Item label="Model">{open.alias} → {open.provider}/{open.model}</Descriptions.Item>
+            <Descriptions.Item label="Client asked for">{open.requestedModel ?? '—'}{open.resolvedVia ? ` (${open.resolvedVia === 'exact' ? 'exact alias' : open.resolvedVia === 'alias' ? 'matched by the opus/sonnet/haiku map' : 'unknown name, sent to the default model'})` : ''}</Descriptions.Item>
+            <Descriptions.Item label="Router chose">{open.askedAlias ?? '—'}</Descriptions.Item>
+            <Descriptions.Item label="Answered by">{open.alias} → {open.provider}/{open.model}</Descriptions.Item>
             <Descriptions.Item label="Key">{open.key ?? '—'}</Descriptions.Item>
             <Descriptions.Item label="Session">{open.sessionId ?? '—'}</Descriptions.Item>
             <Descriptions.Item label="Context (prompt)">{fmtExact(open.ctx)} ({fmtCompact(open.ctx)})</Descriptions.Item>
@@ -141,6 +143,22 @@
             <Descriptions.Item label="Cost (estimate)">{fmtUsd(open.cost)}</Descriptions.Item>
           </Descriptions>
         )}
+        {open && open.trace.length > 0 && (
+          <div style={{ marginTop: 16 }}>
+            <Typography.Text strong>Route taken</Typography.Text>
+            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
+              {open.trace.map((t, i) => (
+                <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
+                  <Tag color={t.outcome === 'served' ? 'success' : t.outcome === 'retry' ? 'processing' : t.outcome === 'failed' ? 'error' : 'warning'} style={{ margin: 0 }}>{t.outcome}</Tag>
+                  <span>
+                    <b>{t.route}</b>{t.key ? ` · ${t.key}` : ''}
+                    {t.detail ? <Typography.Text type="secondary"> — {t.detail}</Typography.Text> : null}
+                  </span>
+                </div>
+              ))}
+            </div>
+          </div>
+        )}
       </Drawer>
       <Space />
     </div>
````

### `src/web/src/pages/Providers.tsx` — key resting reason

````diff
--- a/src/web/src/pages/Providers.tsx
+++ b/src/web/src/pages/Providers.tsx
@@ -100,6 +100,8 @@
   last4: string;
   cooldownSeconds: number;
   cooling: boolean;
+  /** Why the key is resting, e.g. "HTTP 429: code 1113: Insufficient balance". */
+  cooldownReason?: string | null;
   lastUsed?: number;
 }
 
@@ -727,8 +729,8 @@
         !k.configured ? (
           <Tag color="red">not set</Tag>
         ) : k.cooling ? (
-          <Tooltip title={`Cooling down for another ${k.cooldownSeconds}s`}>
-            <Tag color="orange">cooling {k.cooldownSeconds}s</Tag>
+          <Tooltip title={`Resting for another ${k.cooldownSeconds}s${k.cooldownReason ? `. Last error: ${k.cooldownReason}` : ''}. While it rests, requests skip this key and use the next model in the fallback list.`}>
+            <Tag color="orange">resting {k.cooldownSeconds}s</Tag>
           </Tooltip>
         ) : (
           <Tag color="green">ready</Tag>
````

### `src/web/src/pages/Settings.tsx` — Routing tab: failover behaviour + retries

````diff
--- a/src/web/src/pages/Settings.tsx
+++ b/src/web/src/pages/Settings.tsx
@@ -109,7 +109,15 @@
   const [st, setSt] = useState<RoutingState | null>(null);
   const load = useCallback(() => api<RoutingState>('/admin/settings').then(setSt), []);
   useEffect(() => { void load(); }, [load]);
+  const { settings, reload } = useAppSettings();
   if (!st) return null;
+  const saveApp = async (v: Record<string, unknown>) => {
+    try {
+      await api('/admin/app-settings', { method: 'PUT', body: JSON.stringify({ settings: v }) });
+      await reload();
+      message.success('Saved');
+    } catch (e) { message.error(cleanErr(e)); }
+  };
   const opts = [{ value: '', label: '— none —' }, ...st.models.map((m) => ({ value: m, label: m }))];
   const save = async (patch: Partial<Pick<RoutingState, 'defaultModel' | 'aliases'>>) => {
     try {
@@ -119,6 +127,24 @@
     } catch (e) { message.error(cleanErr(e)); }
   };
   return (
+    <>
+    <Section
+      title="When the model you picked fails"
+      description={<>Each model can have a fallback list (Models page). <b>Switch automatically</b> keeps you working when a provider runs out of balance or hits a limit, but it means a different model answers. Every such switch is shown in History as a red “asked …” tag with the reason. <b>Stop and show the error</b> never switches: you see the provider's own error in Claude Code. Before it switches or stops, the router retries a rate limit (HTTP 429) on the same key a few times, because those usually clear in a second or two. Errors about balance, quota or permission are not retried.</>}
+    >
+      <Form layout="vertical" disabled={!isAdmin}>
+        <Form.Item label="Behaviour">
+          <Segmented
+            value={settings['routing.failover']}
+            onChange={(v) => void saveApp({ 'routing.failover': v })}
+            options={[{ value: 'auto', label: 'Switch automatically' }, { value: 'off', label: 'Stop and show the error' }]}
+          />
+        </Form.Item>
+        <Form.Item label="Quick retries on the same key before giving up" tooltip="0 = never retry. Only short rate-limit and network errors are retried.">
+          <InputNumber min={0} max={5} value={settings['routing.retries']} onChange={(v) => v != null && void saveApp({ 'routing.retries': v })} style={{ width: 120 }} />
+        </Form.Item>
+      </Form>
+    </Section>
     <Section title="Which model answers by default" description="Claude Code asks for opus / sonnet / haiku (or any alias you type with /model). These decide where those names go. A name the router does not know falls back to the default model.">
       <Form layout="vertical" disabled={!isAdmin}>
         <Form.Item label="Default model (used for unknown names)">
@@ -131,6 +157,7 @@
         ))}
       </Form>
     </Section>
+    </>
   );
 }
 
````

## Verify

```bash
npx tsc --noEmit                              # no output
cd src/web && npx tsc --noEmit && cd ../..    # no output
npm run build                                 # "built in ..."
node scripts/smoke.mjs && node scripts/admin-smoke.mjs && node scripts/guard-smoke.mjs && node scripts/routing-smoke.mjs   # ALL PASSED x4
```
Restart the router, hard-refresh the browser.

What I ran on exactly this code: the four suites above (`routing-smoke.mjs` has 24 checks: a balance-style 429 is tried once, never retried, and the fallback answers with headers saying who and why; while resting, the failing upstream is **not** hit again and the trace says `resting 600s after HTTP 429: code 1113: Insufficient balance...`; a rate-limit 429 that clears is retried twice and answered by the **same** model with no failover; `failover off` returns the provider's own 429 and, while resting, a clear message naming the reason and the setting; failed requests appear in history; a missing key is explained; `GLM`, `claude-sonnet-4-5` and an unknown name are recorded as exact / alias / default; a key-like token in an upstream error is redacted). Also a real headless Chromium: History shows the red "asked glm" tag and Details shows the route taken; Settings > Routing shows the new control; no page errors.

## What to do after applying (for the human, not the AI)
1. Models > `glm` > **⚡**: the dialog shows Z.ai's own reply. That is the real reason `glm` fails.
2. Use VS Code normally for a minute, then History > newest row > **Details**. Read **Client asked for**: if it says `ds-flash` while you selected glm, the extension sent that name (see `GUIDE-BN.md` section 3: check `claudeCode.environmentVariables` for `ANTHROPIC_MODEL`). If it says `glm` and the row has "asked glm", Z.ai is failing (see the reason in **Route taken**).
