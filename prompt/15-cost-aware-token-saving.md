# 15 — Cost-aware token saving: stop the guard and memory from costing more than they save

**Run after 13 and 14.** Node server, the web UI, the Bangla guide and one benchmark script.

## What the measurement showed (and what it corrects)

I replayed one long coding session through the real router in several settings (`scripts/token-benchmark.mjs`, included below). The session shape comes from your real log (about 2,400 tokens of growth per request, Claude Code compacting itself every ~80 requests). The provider is a mock that bills like a prefix cache: the start of each request that is byte-identical to the previous one is a cache read, the rest is fresh input. 240 requests, tool output assumed to be 80% of the growth (an assumption: your own share is in Usage > "Where your prompt tokens go"). DeepSeek Flash off-peak prices. Every scenario has its own session and tool ids.

| Setting | Tokens | Cost on a cache-priced provider | Cost on a provider with no cache or a quota |
|---|---|---|---|
| Nothing (client compacts at 165K) | 21.6M | $0.216 | $3.29 |
| Client compacts earlier (120K) | -24% | **-7%** | -24% |
| Router context guard | -27% | **+13%** | -26% |
| Guard + router memory | -41% | **+20%** | -39% |
| Everything + client 120K | -45% | **+17%** | -44% |
| Guard + memory on a cache-priced model, after this prompt (Auto) | 0% | 0% | 0% |

At 50% tool output: guard -15% tokens but +24% cost; memory -43% tokens but +38% cost.

**Why:** cached input is about 50 times cheaper than fresh input on providers like DeepSeek. Every time the guard or memory rewrites the start of the prompt, the provider re-reads the whole prompt at the full price once. That costs more than the small per-request saving on cheap cached tokens. On a provider without a cache, or with a daily or per-minute quota, tokens are what you pay with, so the same change is a pure saving.

**This corrects what I told you earlier.** I said the guard and memory "keep the cache working" and suggested switching them on after watching the Measure-only number. That was wrong for cache-priced providers: they reduce tokens, and they can raise the bill. My first benchmark run also had a bug of mine (scenarios shared one session id and leaked the guard's memory into each other), which made memory look even worse; the table above is the corrected run.

What this prompt changes:
1. **`optimise.scope`** (new setting, default `auto`; Settings > Context guard > "Where to shrink prompts"). In `auto` the guard, the prompt shrinking and router memory are skipped for a model whose cached input is at least half price off (`price.cacheRead <= 0.5 * price.in`). They still run for: providers with a daily request or token limit, models with a context window of 200K or less, models with no price set (treated as free or quota-bound), and models without a real cache discount. `always` restores the old behaviour. The decision is made from the model the client asked for. Because the router can only tell when prices are set, fill them in Settings > Pricing.
2. **Minimum batch rule in the guard.** If everything that could still be cleared adds up to less than half of the gap between the high and low marks (a prompt that is mostly text that cannot be cleared), the guard now leaves the prompt alone. Before, it degenerated into clearing one old result on nearly every request, which re-bills the tail of the prompt each time (10 prefix rewrites in 66 requests in the test, 4 after).
3. **Honest texts** on the Context guard and Memory tabs (tokens versus money) and in `GUIDE-BN.md` section 8(0).
4. **`scripts/token-benchmark.mjs`** (`npm run bench:tokens`): run it with your own prices and tool share. `STEPS=240 TOOL_SHARE=0.6 node scripts/token-benchmark.mjs`.

What still cannot be claimed: the tool-output share and the growth rate are your log's and an assumption; real providers round cache blocks and expire caches, which this mock does not model. Real dollars depend on your provider's cache pricing, which is why the benchmark prints both columns.

## How to work (read this first)

- This file is **complete**. Do not open, search or read any other file or folder. For a diff, open only that one file.
- Apply each diff from the repo root with `git apply --ignore-whitespace --whitespace=nowarn <file.patch>` (save the block to a `.patch` file first) or edit by hand: `-` lines removed, `+` lines added, the rest is context. If a hunk already looks like the `+` version, skip it and say so.
- Existing files use Windows line endings (CRLF); keep them. No refactors, no renames, no formatting changes.
- Do **not** touch the user's VS Code settings or `~/.claude/settings.json`. Never print, log or commit `.env` values.
- Finish by running the verification commands and paste their **real output**.

## Steps

### Step 1 — Create these new files

### `scripts/optimise-smoke.mjs` — NEW file

````js
// Offline test: shrinking is applied only where it pays off, and never degenerates into per-request rewrites.
// Run: npm run build && node scripts/optimise-smoke.mjs
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, "..", "dist", "index.js");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "router-optimise-"));
const PORT = 21987;

let last = null;
const mock = http.createServer((req, res) => {
  let data = "";
  req.on("data", (c) => (data += c));
  req.on("end", () => {
    last = data;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ type: "message", content: [{ type: "text", text: "ok" }], usage: { input_tokens: 100, output_tokens: 10 } }));
  });
});
await new Promise((r) => mock.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${mock.address().port}`;

fs.writeFileSync(path.join(home, "routes.json"), JSON.stringify({
  defaultModel: "cached", aliases: {},
  providers: {
    a: { baseURL: base, auth: "bearer", keys: ["A_KEY"] },
    q: { baseURL: base, auth: "bearer", keys: ["A_KEY"], dailyTokens: 50_000_000 },
  },
  models: {
    cached: { provider: "a", model: "m1", key: "A_KEY", price: { in: 0.15, out: 0.6, cacheRead: 0.003 } },
    nocache: { provider: "a", model: "m2", key: "A_KEY", price: { in: 0.5, out: 1.5 } },
    weakcache: { provider: "a", model: "m2b", key: "A_KEY", price: { in: 1, out: 2, cacheRead: 0.8 } },
    free: { provider: "a", model: "m3", key: "A_KEY" },
    quota: { provider: "q", model: "m4", key: "A_KEY", price: { in: 0.15, out: 0.6, cacheRead: 0.003 } },
    smallwin: { provider: "a", model: "m5", key: "A_KEY", contextWindow: 128000, price: { in: 0.15, out: 0.6, cacheRead: 0.003 } },
  },
}));
fs.writeFileSync(path.join(home, ".env"), `ROUTER_PORT=${PORT}\nROUTER_KEY="secret-router"\nA_KEY=K-A\n`);
const child = spawn(process.execPath, [dist], { env: { ...process.env, ROUTER_HOME: home }, stdio: "pipe" });
await new Promise((r) => setTimeout(r, 1300));
const R = `http://127.0.0.1:${PORT}`;
const H = { "content-type": "application/json", "x-api-key": "secret-router", origin: R };
const admin = (p, init = {}) => fetch(R + p, { ...init, headers: { ...H, ...(init.headers || {}) } });
const set = (s) => admin("/admin/app-settings", { method: "PUT", body: JSON.stringify({ settings: s }) });
const post = async (b) => { const r = await fetch(R + "/v1/messages", { method: "POST", headers: H, body: JSON.stringify({ max_tokens: 50, ...b }) }); await r.text(); return r; };
let fails = 0;
const t = (n, ok, x = "") => { console.log((ok ? "PASS " : "FAIL ") + n + (x ? "  " + x : "")); if (!ok) fails++; };

const convo = (pairs, session, chars = 12000) => {
  const messages = [{ role: "user", content: [{ type: "text", text: "go" }] }];
  for (let i = 0; i < pairs; i++) {
    messages.push({ role: "assistant", content: [{ type: "tool_use", id: "t" + i, name: "Read", input: { i } }] });
    messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: "t" + i, content: "z".repeat(chars) }] });
  }
  return { messages, system: "S".repeat(2000), metadata: { user_id: session } };
};

await set({ "guard.mode": "on", "guard.highTokens": 20000, "guard.lowTokens": 8000, "memory.mode": "off" });
const big = (model, sid) => ({ model, ...convo(50, sid) });
const raw = JSON.stringify(big("cached", "x").messages).length;

let s = await (await admin("/admin/app-settings")).json();
t("default scope is auto", s.settings["optimise.scope"] === "auto");
let pr = await set({ "optimise.scope": "sometimes" });
t("invalid scope refused", pr.status === 400);

// which routes get shrunk in "auto"
const sizeFor = async (model, sid) => { await post(big(model, sid)); return JSON.parse(last).messages; };
const untouched = (m) => JSON.stringify(m).length > raw * 0.95;
t("cache-priced model (cached input 50x cheaper): prompt left untouched", untouched(await sizeFor("cached", "s-cached")));
t("model with no cache discount: prompt shrunk", !untouched(await sizeFor("nocache", "s-nocache")));
t("model whose cache discount is small: prompt shrunk", !untouched(await sizeFor("weakcache", "s-weak")));
t("model with no price set (free / unknown): prompt shrunk", !untouched(await sizeFor("free", "s-free")));
t("provider with a daily quota: prompt shrunk even when cache-priced", !untouched(await sizeFor("quota", "s-quota")));
t("small context window: prompt shrunk even when cache-priced", !untouched(await sizeFor("smallwin", "s-small")));
await set({ "optimise.scope": "always" });
t("scope always: cache-priced model is shrunk too", !untouched(await sizeFor("cached", "s-cached2")));
await set({ "optimise.scope": "auto" });
await new Promise((r) => setTimeout(r, 300));
const rows = (await (await admin("/admin/requests?limit=3")).json()).rows;
t("history shows no saving when shrinking was skipped", (await (await admin("/admin/requests?limit=50&q=cached")).json()).rows.filter((x) => x.requestedModel === "cached" && x.guardSaved === 0).length >= 1);

// ---- the guard must not rewrite the prompt on every request once the clearable part is used up
// 60 growing requests where most growth is text that can NOT be cleared (floor rises above the high mark)
const conv = (n) => {
  const m = [{ role: "user", content: [{ type: "text", text: "start" }] }];
  for (let i = 0; i < n; i++) {
    m.push({ role: "assistant", content: [{ type: "text", text: "t".repeat(3000) }, { type: "tool_use", id: "u" + i, name: "Read", input: { i } }] });
    m.push({ role: "user", content: [{ type: "tool_result", tool_use_id: "u" + i, content: "r".repeat(2500) }, { type: "text", text: "x".repeat(1500) }] });
  }
  return { model: "free", messages: m, system: "S".repeat(2000), metadata: { user_id: "s-churn" } };
};
let prevBody = "", rewrites = 0;
for (let n = 4; n <= 70; n++) {
  await post(conv(n));
  const cur = last;
  if (prevBody) {
    // where does this request first differ from the previous one? Anything but the tail means the prefix was rewritten.
    let i = 0; const lim = Math.min(cur.length, prevBody.length);
    while (i < lim && cur.charCodeAt(i) === prevBody.charCodeAt(i)) i++;
    if (i < prevBody.length * 0.6) rewrites++;
  }
  prevBody = cur;
}
t("text-heavy session: the prefix is NOT rewritten on every request", rewrites <= 4, `rewrites in 66 requests = ${rewrites}`);

// ---- a real batch still happens when there is plenty to clear
await set({ "guard.highTokens": 20000, "guard.lowTokens": 8000 });
const r1 = await sizeFor("free", "s-batch");
const cleared = r1.filter((m) => m.role === "user").flatMap((m) => m.content).filter((b) => b.type === "tool_result" && /cleared to save tokens/.test(String(b.content))).length;
t("tool-heavy session: one big batch clears most old results", cleared >= 30, `${cleared} of 50 cleared`);

child.kill();
fs.rmSync(home, { recursive: true, force: true });
mock.close();
console.log(fails ? `\n${fails} FAILED` : "\nALL PASSED");
process.exit(fails ? 1 : 0);
````

### `scripts/token-benchmark.mjs` — NEW file

````js
// Token benchmark. Replays one long coding-agent session through the REAL router in several settings
// and compares tokens and estimated cost. Run:  npm run build && node scripts/token-benchmark.mjs
//
// How to read it:
//  * The session shape (growth per request, where the client compacts itself) comes from a real log.
//  * The "provider" is a mock that behaves like a prefix cache: tokens that are byte-identical to the START of
//    the previous request are billed as cache reads, the rest as fresh input. So cache misses caused by the
//    optimisation itself are counted, not ignored.
//  * Everything is scaled down by SCALE to keep it fast; reported numbers are multiplied back.
//  * The share of the prompt that is old tool output is an ASSUMPTION (TOOL_SHARE). Your own share is shown
//    in the UI under Usage > "Where your prompt tokens go". Change TOOL_SHARE to match it and run again.
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, "..", "dist", "index.js");
const SCALE = 4; // 1 simulated token = SCALE real tokens
const STEPS = Number(process.env.STEPS ?? 240);
const TOOL_SHARE = Number(process.env.TOOL_SHARE ?? 0.8); // share of growth that is tool output
const CPT = 3.5;

// ---- real-log parameters (tokens, unscaled)
const REAL = { growthPerRequest: 2400, startAfterCompact: 36000, clientCompactAt: 165000, systemAndTools: 12000, outPerRequest: 312 };
// ---- DeepSeek V4 Flash list prices, USD per 1M tokens (off-peak)
const PRICE = { fresh: 0.15, cache: 0.003, out: 0.60 };

const tok = (n) => Math.round(n / SCALE); // real -> simulated
const chars = (simTokens) => Math.round(simTokens * CPT);

// ---- mock provider with a byte-prefix cache
let prev = "";
let cacheHit = 0, fresh = 0, outTok = 0, reqs = 0, maxPrompt = 0;
const prompts = [];
let sumCalls = 0, sumIn = 0, sumOut = 0;
const mock = http.createServer((req, res) => {
  let data = "";
  req.on("data", (c) => (data += c));
  req.on("end", () => {
    const key = req.headers["x-api-key"] || String(req.headers.authorization || "").replace("Bearer ", "");
    const body = JSON.parse(data || "{}");
    if (key === "K-SUM") {
      sumCalls++;
      const inTok = Math.ceil(String(body.messages?.[0]?.content ?? "").length / CPT);
      sumIn += inTok; sumOut += 300 / SCALE;
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ type: "message", content: [{ type: "text", text: "Goal and state: " + "kept facts and decisions. ".repeat(Math.round(tok(1500) * CPT / 26)) }], usage: { input_tokens: inTok, output_tokens: Math.round(300 / SCALE) } }));
    }
    const { model, max_tokens, metadata, stream, ...rest } = body; // what a provider's cache keys on
    const s = JSON.stringify(rest);
    let i = 0; const lim = Math.min(s.length, prev.length);
    while (i < lim && s.charCodeAt(i) === prev.charCodeAt(i)) i++;
    const total = Math.ceil(s.length / CPT);
    const cached = Math.min(total, Math.floor(i / CPT / 16) * 16); // 16-token blocks
    prev = s;
    cacheHit += cached; fresh += total - cached; reqs++; maxPrompt = Math.max(maxPrompt, total); prompts.push(total);
    const o = tok(REAL.outPerRequest);
    outTok += o;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ type: "message", content: [{ type: "text", text: "ok" }], usage: { input_tokens: total - cached, output_tokens: o, cache_read_input_tokens: cached } }));
  });
});
await new Promise((r) => mock.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${mock.address().port}`;

const home = fs.mkdtempSync(path.join(os.tmpdir(), "router-bench-"));
fs.writeFileSync(path.join(home, "routes.json"), JSON.stringify({
  defaultModel: "main", aliases: {},
  providers: { p: { baseURL: base, auth: "bearer", keys: ["MAIN_KEY", "SUM_KEY"] } },
  models: {
    main: { provider: "p", model: "main-up", key: "MAIN_KEY" }, // no price set: treated as free / quota-bound
    mainp: { provider: "p", model: "mainp-up", key: "MAIN_KEY", price: { in: 0.15, out: 0.6, cacheRead: 0.003 } }, // DeepSeek-style cache pricing
    cheap: { provider: "p", model: "cheap-up", key: "SUM_KEY" },
  },
}));
fs.writeFileSync(path.join(home, ".env"), `ROUTER_PORT=21988\nROUTER_KEY="bench"\nMAIN_KEY=K-MAIN\nSUM_KEY=K-SUM\n`);
const logFd = process.env.ROUTER_LOG ? fs.openSync(process.env.ROUTER_LOG, "w") : "ignore";
const child = spawn(process.execPath, [dist], { env: { ...process.env, ROUTER_HOME: home }, stdio: ["ignore", logFd, logFd] });
await new Promise((r) => setTimeout(r, 1300));
const R = "http://127.0.0.1:21988";
const H = { "content-type": "application/json", "x-api-key": "bench", origin: R };
const settings = (s) => fetch(R + "/admin/app-settings", { method: "PUT", headers: H, body: JSON.stringify({ settings: s }) }).then(async (r) => { if (!r.ok) throw new Error(await r.text()); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- deterministic session generator (same conversation for every scenario)
function rng(seed) { let x = seed; return () => ((x = (x * 1664525 + 1013904223) >>> 0) / 2 ** 32); }
function session(clientCompactAtReal, model = "main", tag = "x") {
  const rand = rng(42);
  const systemText = "S".repeat(chars(tok(REAL.systemAndTools * 0.7)));
  const toolsDef = [{ name: "Read", description: "D".repeat(chars(tok(REAL.systemAndTools * 0.3))), input_schema: { type: "object" } }];
  const seedMsgs = () => [{ role: "user", content: [{ type: "text", text: "Fix the retry bug in the billing module and keep the public API." + " Context: ".padEnd(chars(tok(REAL.startAfterCompact - REAL.systemAndTools - 2000)), "c") }] }];
  let messages = seedMsgs();
  let n = 0;
  return {
    next() {
      // add one assistant tool call + its result; sizes vary (log-normal-ish) around the real average growth
      const jitter = 0.35 + rand() * 1.3;
      const growth = REAL.growthPerRequest * jitter;
      const toolTok = growth * TOOL_SHARE, textTok = growth * (1 - TOOL_SHARE);
      const id = `${tag}-t${n++}`;
      messages.push({ role: "assistant", content: [{ type: "text", text: "a".repeat(chars(tok(textTok * 0.6))) }, { type: "tool_use", id, name: "Read", input: { file_path: `/src/file${n}.ts`, note: "n".repeat(chars(tok(textTok * 0.2))) } }] });
      messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: id, content: String.fromCharCode(97 + (n % 26)).repeat(chars(tok(toolTok))) }, { type: "text", text: "u".repeat(chars(tok(textTok * 0.2))) }] });
      const body = { model, max_tokens: 100, system: systemText, tools: toolsDef, messages, metadata: { user_id: `bench-${tag}` } };
      const approx = (JSON.stringify(body).length / CPT) * SCALE;
      if (clientCompactAtReal && approx > clientCompactAtReal) {
        // the client compacts itself: one summary message + the newest messages (history is rewritten)
        const keep = messages.slice(-6);
        messages = [{ role: "user", content: [{ type: "text", text: "[client summary] " + "s".repeat(chars(tok(2000))) }] }, ...keep.filter((_, i) => i > 0 || keep[0].role === "user")];
        if (messages[1]?.role === "user") messages.splice(1, 1);
      }
      return { ...body, messages };
    },
  };
}

async function run(name, cfg, clientCompactAtReal, model = "main") {
  prev = ""; cacheHit = fresh = outTok = reqs = maxPrompt = 0; prompts.length = 0; sumCalls = 0; sumIn = 0; sumOut = 0;
  await settings(cfg);
  await fetch(R + "/admin/memory/clear", { method: "POST", headers: H, body: "{}" });
  const s = session(clientCompactAtReal, model, name.split(".")[0] + "-" + Math.random().toString(36).slice(2, 7));
  for (let i = 0; i < STEPS; i++) {
    const r = await fetch(R + "/v1/messages", { method: "POST", headers: H, body: JSON.stringify(s.next()) });
    await r.text();
    await sleep(18);
  }
  await sleep(300);
  const inputTok = (cacheHit + fresh) * SCALE;
  const cost = ((fresh * SCALE) * PRICE.fresh + (cacheHit * SCALE) * PRICE.cache + (outTok * SCALE) * PRICE.out + (sumIn * SCALE) * PRICE.fresh + (sumOut * SCALE) * PRICE.out) / 1e6;
  // a provider WITHOUT a prompt cache (or a free tier where every token counts against a quota): all input costs the same
  const costNoCache = ((inputTok + sumIn * SCALE) * PRICE.fresh + (outTok * SCALE + sumOut * SCALE) * PRICE.out) / 1e6;
  const sorted = [...prompts].sort((a, b) => a - b);
  return {
    name, requests: reqs, promptTokens: inputTok, freshTokens: fresh * SCALE, cachePct: (cacheHit / (cacheHit + fresh)) * 100,
    avgPrompt: inputTok / reqs, p90: sorted[Math.floor(sorted.length * 0.9)] * SCALE, maxPrompt: maxPrompt * SCALE, cost, costNoCache, summaries: sumCalls,
  };
}

// Thresholds are scaled with the data, so the router sees the same SHAPE as in real life.
const T = (n) => Math.round(n / SCALE);
const GUARD = { "guard.mode": "on", "guard.highTokens": T(90000), "guard.lowTokens": T(45000), "guard.minChars": T(1200) };
const MEM = { "memory.mode": "on", "memory.model": "cheap", "memory.highTokens": T(80000), "memory.lowTokens": T(35000) };
const OFF = { "guard.mode": "off", "memory.mode": "off" };
const scenarios = [
  ["A. Nothing (client compacts at 165K, like your log)", OFF, REAL.clientCompactAt],
  ["B. Client compacts earlier (120K setting only)", OFF, 120000],
  ["C. Router context guard ON", { ...GUARD, "memory.mode": "off" }, REAL.clientCompactAt],
  ["C2. Guard ON, cleared down to a LOWER 25K", { ...GUARD, "guard.lowTokens": T(25000), "memory.mode": "off" }, REAL.clientCompactAt],
  ["D. Guard ON + router memory ON", { ...GUARD, ...MEM }, REAL.clientCompactAt],
  ["E. Everything: guard + memory + client 120K", { ...GUARD, ...MEM }, 120000],
  ["F. Guard + memory ON, cache-priced model (auto)", { ...GUARD, ...MEM }, REAL.clientCompactAt, "mainp"],
];
const results = [];
for (const [name, cfg, cc, model] of scenarios.filter((x) => !process.env.ONLY || x[0].startsWith(process.env.ONLY))) {
  process.stdout.write(`running ${name} ...\n`);
  results.push(await run(name, cfg, cc, model));
}
child.kill(); mock.close(); fs.rmSync(home, { recursive: true, force: true });

const f = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? (n / 1e3).toFixed(0) + "K" : String(Math.round(n)));
const base0 = results[0];
console.log(`\nSession: ${STEPS} requests, tool output = ${(TOOL_SHARE * 100).toFixed(0)}% of growth (assumption). Prices: DeepSeek Flash off-peak, USD per 1M tokens (fresh ${PRICE.fresh}, cache ${PRICE.cache}, output ${PRICE.out}).\n`);
console.log("scenario".padEnd(48), "tokens".padStart(8), "vs A".padStart(6), "fresh".padStart(7), "cache%".padStart(7), "avg".padStart(6), "p90".padStart(6), "max".padStart(6), "$ cached".padStart(9), "vs A".padStart(6), "$ no-cache".padStart(11), "vs A".padStart(6), "sum");
for (const r of results) {
  const pc = (a, b) => (((a / b) - 1) * 100).toFixed(0).padStart(5) + "%";
  console.log(r.name.padEnd(48), f(r.promptTokens).padStart(8), pc(r.promptTokens, base0.promptTokens), f(r.freshTokens).padStart(7), (r.cachePct.toFixed(0) + "%").padStart(7), f(r.avgPrompt).padStart(6), f(r.p90).padStart(6), f(r.maxPrompt).padStart(6), ("$" + r.cost.toFixed(3)).padStart(9), pc(r.cost, base0.cost), ("$" + r.costNoCache.toFixed(3)).padStart(11), pc(r.costNoCache, base0.costNoCache), String(r.summaries).padStart(3));
}
console.log("\nJSON " + JSON.stringify({ toolShare: TOOL_SHARE, steps: STEPS, results }));
````

### Step 2 — Apply these diffs

### `src/contextGuard.ts` — minimum batch rule

````diff
--- a/src/contextGuard.ts
+++ b/src/contextGuard.ts
@@ -82,6 +82,7 @@
 
 export const inputStub = (chars: number): string => `[router: ${chars} characters cleared to save tokens]`;
 
+/** Same shape, big strings replaced: the model still sees which tool was called on which file. */
 function trimStrings(v: Json, min: number, depth = 0): Json {
   if (typeof v === "string") return v.length >= min ? inputStub(v.length) : v;
   if (depth >= INPUT_DEPTH || v == null || typeof v !== "object") return v;
@@ -214,8 +215,18 @@
     });
 
     // 2) only when the prompt is over the high-water mark, clear MORE (oldest first) down to the low-water mark.
+    // A rewrite breaks the provider's prompt cache from the first changed message onward, so it must be worth it:
+    // if everything that could still be cleared adds up to less than half of the high-to-low gap (the prompt is
+    // mostly text that cannot be cleared), leave the prompt alone. Without this rule the guard degenerates into
+    // clearing one old result per request, which re-bills the tail of the prompt on every single request.
     let clearedNow = 0;
     if (est > cfg.highTokens) {
+      let available = 0;
+      for (let i = 0; i < protectedFrom; i++) {
+        const s = slots[i];
+        if (!apply.has(i) && !s.hasImage && s.chars >= cfg.minChars) available += gain(s);
+      }
+      if (available >= Math.round((cfg.highTokens - cfg.lowTokens) / 2)) {
       for (let i = 0; i < protectedFrom && est > cfg.lowTokens; i++) {
         const s = slots[i];
         if (apply.has(i) || s.hasImage || s.chars < cfg.minChars) continue;
@@ -226,6 +237,7 @@
         else cleared.add(s.id);
       }
     }
+    }
     // 3) the tool CALL of every cleared result: shrink the big strings inside its input as well.
     const uses = new Map<string, { mi: number; bi: number }>();
     if (cfg.trimInputs) {
````

### `src/capacity.ts` — shrinkWorthy(): is shrinking worth it for this route

````diff
--- a/src/capacity.ts
+++ b/src/capacity.ts
@@ -1,5 +1,6 @@
 import type { ModelCfg, ProviderCfg } from "./config";
 import { applyGuard, estimateTokens, readConfig } from "./contextGuard";
+import { getSetting } from "./db";
 import { providerToday } from "./history";
 
 const fmt = (n: number): string =>
@@ -21,6 +22,24 @@
   return null;
 }
 
+/**
+ * Shrinking the prompt saves TOKENS, but every rewrite re-bills the prompt at the full input price. On a provider
+ * whose cached input costs a fraction of normal input (DeepSeek and similar) that costs more money than it saves;
+ * on a provider without a cache, or with a daily/per-minute quota, tokens are exactly what you pay with.
+ * "auto" therefore shrinks only when it pays off: quota-limited providers, small context windows, models with no
+ * price set (assumed free/quota-bound) and models whose cached input is not much cheaper than normal input.
+ */
+export function shrinkWorthy(m: ModelCfg | undefined, p: ProviderCfg | undefined): boolean {
+  if ((getSetting("optimise.scope") as string) === "always") return true;
+  if (!m || !p) return true;
+  if (p.dailyTokens || p.dailyRequests) return true;
+  if (m.contextWindow && m.contextWindow <= 200_000) return true;
+  const price = m.price;
+  if (!price) return true;
+  const cached = price.cacheRead ?? price.in;
+  return cached > price.in * 0.5;
+}
+
 export interface Fit {
   body: Record<string, unknown>;
   /** Tokens removed from the prompt so it fits this route's window. */
````

### `src/db.ts` — setting optimise.scope

````diff
--- a/src/db.ts
+++ b/src/db.ts
@@ -142,6 +142,7 @@
   "guard.minChars": 1200,
   "routing.failover": "auto",
   "routing.retries": 2,
+  "optimise.scope": "auto",
   "guard.trimInputs": true,
   "guard.trimPastes": false,
   "guard.pasteChars": 12_000,
````

### `src/admin.ts` — validate optimise.scope

````diff
--- a/src/admin.ts
+++ b/src/admin.ts
@@ -1233,6 +1233,9 @@
     else if (k === "pricing.peakMultiplier") {
       const n = Number(input[k]);
       if (!Number.isFinite(n) || n < 1 || n > 10) errors.push({ field: k, message: "must be a number from 1 to 10" }); else clean[k] = n;
+    } else if (k === "optimise.scope") {
+      if (input[k] !== "auto" && input[k] !== "always") errors.push({ field: k, message: "must be auto or always" });
+      else clean[k] = input[k];
     } else if (k === "guard.trimInputs" || k === "guard.trimPastes") {
       if (typeof input[k] !== "boolean") errors.push({ field: k, message: "must be true or false" });
       else clean[k] = input[k];
````

### `src/index.ts` — skip shrinking and memory when it would cost more

````diff
--- a/src/index.ts
+++ b/src/index.ts
@@ -14,7 +14,7 @@
 import * as eta from "./eta";
 import * as live from "./live";
 import { costOf } from "./pricing";
-import { budgetReason, fitToWindow } from "./capacity";
+import { budgetReason, fitToWindow, shrinkWorthy } from "./capacity";
 import { classifyFailure } from "./failure";
 import { adaptOpenAI, openaiHeaders, toOpenAIRequest } from "./openai";
 import { getSetting } from "./db";
@@ -281,9 +281,12 @@
       .join(" | ");
 
   // Context guard: clear OLD tool outputs (remembered per session) before the prompt goes upstream.
-  const guard = applyGuard(body, sessionId);
+  // Shrinking only pays off where tokens are what you spend (see shrinkWorthy); on a cache-priced model it is skipped.
+  const shrink = shrinkWorthy(c.models[alias], c.providers[c.models[alias].provider]);
+  const skipped = { mode: "off" as const, beforeTokens: 0, afterTokens: 0, saved: 0, would: 0, clearedNow: 0, clearedTotal: 0 };
+  const guard = shrink ? applyGuard(body, sessionId) : { body, result: skipped };
   // Router memory: replace the old part of a long conversation by the stored summary (written in the background).
-  const memory = applyMemory(body, guard.body, sessionId);
+  const memory = shrink ? applyMemory(body, guard.body, sessionId) : { body: guard.body, result: { mode: "off" as const, saved: 0, would: 0, covers: 0, pending: false } };
   const upstreamBody = memory.body as Record<string, unknown>;
   const anatomy = promptAnatomy(body);
   if (guard.result.saved > 0 || guard.result.clearedNow > 0) {
````

### `src/web/src/appSettings.tsx` — optimise.scope in the settings type and defaults

````diff
--- a/src/web/src/appSettings.tsx
+++ b/src/web/src/appSettings.tsx
@@ -13,6 +13,7 @@
   'guard.minChars': number;
   'routing.failover': 'auto' | 'off';
   'routing.retries': number;
+  'optimise.scope': 'auto' | 'always';
   'guard.trimInputs': boolean;
   'guard.trimPastes': boolean;
   'guard.pasteChars': number;
@@ -34,6 +35,7 @@
   'guard.minChars': 1200,
   'routing.failover': 'auto',
   'routing.retries': 2,
+  'optimise.scope': 'auto',
   'guard.trimInputs': true,
   'guard.trimPastes': false,
   'guard.pasteChars': 12_000,
````

### `src/web/src/pages/Settings.tsx` — honest texts, Where to shrink prompts control

````diff
--- a/src/web/src/pages/Settings.tsx
+++ b/src/web/src/pages/Settings.tsx
@@ -254,12 +254,26 @@
     <>
       <Section
         title="Why this exists"
-        description={<>The model has no memory between requests, so Claude Code sends the whole conversation every time. That cannot be avoided, but most of that conversation is <b>old tool output</b> (files it read, search results, command logs) that the model no longer needs in full. The guard replaces old tool outputs with a one-line note and keeps the newest few. It <b>remembers</b> what it cleared in each session, so later requests get exactly the same notes and the provider's cache keeps working. Clearing happens in rare batches: when the prompt passes the upper limit it is cleared down to the lower limit.</>}
+        description={<>The model has no memory between requests, so Claude Code sends the whole conversation every time. That cannot be avoided, but most of that conversation is <b>old tool output</b> (files it read, search results, command logs) that the model no longer needs in full. The guard replaces old tool outputs with a one-line note and keeps the newest few. It <b>remembers</b> what it cleared in each session, so between clearings every request carries exactly the same text. Clearing happens in batches: when the prompt passes the upper limit it is cleared down to the lower limit, and only if that removes a meaningful amount.</>}
       >
         <Typography.Text type="secondary">
-          Research on coding agents (JetBrains, 2025) found this simple approach roughly halves cost while solving as many tasks as summarising with a second model. The risk: the agent may re-read a file it needs again. Start in <b>Measure only</b>, look at the number below, then switch on.
+          <b>What it saves:</b> tokens, typically a quarter to a third of them in a long tool-heavy session (measured with the benchmark in <code>scripts/token-benchmark.mjs</code>). <b>What it does not always save: money.</b> Every clearing changes the start of the prompt, so the provider re-reads the whole prompt at the full input price once. On a provider whose cached input is far cheaper (DeepSeek and similar) that costs more than it saves, which is why the setting below defaults to <b>Auto</b>. Risk: the agent may re-read a file it needs again. Start in <b>Measure only</b>.
         </Typography.Text>
       </Section>
+      <Section title="Where to shrink prompts">
+        <Form layout="vertical" disabled={!isAdmin}>
+          <Form.Item
+            label="Shrink prompts for"
+            extra="Auto = only where it pays off: providers with a daily limit, models with a small context window, models with no price set (treated as free or quota-bound) and models without a real cache discount. Models whose cached input is at least half price off are left alone. Set prices in Settings > Pricing so the router can tell."
+          >
+            <Segmented
+              value={settings['optimise.scope']}
+              onChange={(v) => void save({ 'optimise.scope': v })}
+              options={[{ value: 'auto', label: 'Auto (recommended)' }, { value: 'always', label: 'Every provider' }]}
+            />
+          </Form.Item>
+        </Form>
+      </Section>
       <Section title="Result (last 24 hours)">
         {!g || (g.saved === 0 && g.would === 0) ? (
           <Alert type="info" showIcon message="Nothing measured yet" description="It starts counting when a prompt grows past the upper limit. Use Claude Code normally and check back." />
@@ -331,10 +345,10 @@
     <>
       <Section
         title="What this is"
-        description={<>The AI model has no memory, so Claude Code sends the whole conversation every time. <b>Router memory</b> remembers for it: when a conversation gets long, a cheap model writes a short summary of the <b>old</b> messages (in the background, so nothing waits). The router stores that summary and, from the next request on, sends it <b>instead of</b> the old messages. The text is the same on every request, so the provider's cache keeps working. Your original request is kept word for word, and the newest messages are never summarised. If the summary model fails, your request goes out unchanged and the router tries again after 5 minutes.</>}
+        description={<>The AI model has no memory, so Claude Code sends the whole conversation every time. <b>Router memory</b> remembers for it: when a conversation gets long, a cheap model writes a short summary of the <b>old</b> messages (in the background, so nothing waits). The router stores that summary and, from the next request on, sends it <b>instead of</b> the old messages. Between summaries the text is the same on every request. Your original request is kept word for word, and the newest messages are never summarised. If the summary model fails, your request goes out unchanged and the router tries again after 5 minutes.</>}
       >
         <Typography.Text type="secondary">
-          Cost and risk: each summary costs a one-time call to the summary model (shown in History as “router memory summary”), and a summary can lose small details. Start with <b>Measure only</b>, read the number below, then switch on. It only works inside one conversation; after <code>/clear</code> a new conversation starts empty, as it should.
+          Cost and risk: each summary costs a call to the summary model (shown in History as “router memory summary”) and changes the start of the prompt, so the provider re-reads it at the full price. It saves tokens, but on a provider with cheap cached input it can cost more money; it uses the same Auto rule as the context guard (Settings &gt; Context guard &gt; Where to shrink prompts). A summary can also lose small details. Start with <b>Measure only</b>. It only works inside one conversation; after <code>/clear</code> a new conversation starts empty, as it should.
         </Typography.Text>
       </Section>
       <Section title="Result (last 24 hours)">
````

### `package.json` — npm scripts smoke:optimise and bench:tokens

````diff
--- a/package.json
+++ b/package.json
@@ -13,12 +13,14 @@
     "check": "tsc --noEmit",
     "smoke": "npm run -s build && node scripts/smoke.mjs",
     "smoke:admin": "npm run -s build && node scripts/admin-smoke.mjs",
-    "smoke:all": "npm run -s smoke && npm run -s smoke:admin && npm run -s smoke:guard && npm run -s smoke:routing && npm run -s smoke:capacity && npm run -s smoke:memory && npm run -s smoke:providers",
+    "smoke:all": "npm run -s smoke && npm run -s smoke:admin && npm run -s smoke:guard && npm run -s smoke:routing && npm run -s smoke:capacity && npm run -s smoke:memory && npm run -s smoke:providers && npm run -s smoke:optimise",
     "smoke:guard": "npm run -s build && node scripts/guard-smoke.mjs",
     "smoke:routing": "npm run -s build && node scripts/routing-smoke.mjs",
     "smoke:capacity": "npm run -s build && node scripts/capacity-smoke.mjs",
     "smoke:memory": "npm run -s build && node scripts/memory-smoke.mjs",
-    "smoke:providers": "npm run -s build && node scripts/providers-smoke.mjs"
+    "smoke:providers": "npm run -s build && node scripts/providers-smoke.mjs",
+    "smoke:optimise": "npm run -s build && node scripts/optimise-smoke.mjs",
+    "bench:tokens": "npm run -s build && node scripts/token-benchmark.mjs"
   },
   "license": "ISC",
   "type": "commonjs",
````

### `GUIDE-BN.md` — Bangla guide: tokens versus money, the benchmark table, the Auto rule

````diff
--- a/GUIDE-BN.md
+++ b/GUIDE-BN.md
@@ -341,12 +341,31 @@
    - প্রথমে Measure only-তে কয়েকদিন চালাও, সংখ্যা দেখো, তারপর `On`। ঝুঁকি: agent কখনো পুরনো ফাইল আবার পড়তে পারে।
 3. **অভ্যাস:** অন্য কাজ শুরু করলে `/clear`; বড় কাজ শেষে `/compact`; দিন শেষে `/r-end`, পরদিন `/clear` তারপর `/r-start`।
 
+### ৮(০) সত্যটা আগে: token কমা আর টাকা কমা এক জিনিস নয়
+আমি `scripts/token-benchmark.mjs` দিয়ে একটা লম্বা কোডিং সেশন (২৪০ request, তোমার আসল log-এর বৃদ্ধির হার: প্রতি request-এ গড়ে ~২,৪০০ token, ৮০ request পরপর Claude Code নিজে compact করে) router-এর মধ্য দিয়ে চালিয়ে মেপেছি। Provider-এর বদলে একটা নকল server, যেটা **prompt cache-এর মতো** আচরণ করে (prompt-এর শুরুর যে অংশ আগের request-এর সাথে হুবহু মেলে সেটা "cache read", বাকিটা "fresh")। ফল (tool output = বৃদ্ধির ৮০% ধরে; এটা **অনুমান**, তোমারটা Usage → "Where your prompt tokens go"-তে দেখো):
+
+| কী করা হলো | token | টাকা: DeepSeek-ধরনের (cache সস্তা) | টাকা: cache নেই / quota-বাঁধা |
+|---|---|---|---|
+| কিছু না (Claude Code ১৬৫K-তে compact) | ২১.৬M | $০.২১৬ | $৩.২৯ |
+| Claude Code আগে compact (১২০K) | −২৪% | **−৭%** | −২৪% |
+| Router Context guard চালু | −২৭% | **+১৩%** | −২৬% |
+| Guard + Router Memory | −৪১% | **+২০%** | −৩৯% |
+| সবকিছু + ১২০K | −৪৫% | **+১৭%** | −৪৪% |
+| Guard + Memory, তবে cache-সস্তা model-এ (Auto) | ০% (ছোঁয়া হয়নি) | ০% | ০% |
+(tool output ৫০% ধরলে: guard −১৫% token কিন্তু +২৪% টাকা; memory −৪৩% token কিন্তু +৩৮% টাকা।)
+
+**কেন টাকা বাড়ে:** DeepSeek-এর মতো provider-এ cache-থেকে-পড়া input সাধারণ input-এর প্রায় ৫০ গুণ সস্তা। Guard বা Memory prompt-এর **শুরুর অংশ** বদলালে provider পুরো prompt একবার **পুরো দামে** আবার পড়ে। তাই token কমলেও (সস্তা) cache-পড়া কমার সাশ্রয় ছোট, আর পুরো দামে আবার-পড়ার খরচ বড়। **যেখানে cache নেই বা quota আছে** (ফ্রি tier, Groq, Gemini...) সেখানে token-ই আসল মুদ্রা, আর কমানো সরাসরি লাভ।
+
+**তাই ডিফল্ট এখন "Auto"** (Settings → Context guard → "Where to shrink prompts"): router শুধু সেখানে ছাঁটে যেখানে লাভ: (১) দৈনিক সীমা দেওয়া provider, (২) ছোট context window-এর model, (৩) দাম বসানো নেই এমন model (ফ্রি/অজানা ধরা হয়), (৪) cache-ছাড় নেই এমন model। যেসব model-এ cache ৫০%-এর বেশি সস্তা (যেমন দাম বসানো DeepSeek) সেগুলো ছোঁয়া হয় না। **তাই Settings → Pricing-এ দাম বসিয়ে রাখো।** সবখানে জোর করে চালাতে চাইলে "Every provider"।
+আরও একটা নিয়ম: আগে guard প্রায় প্রতি request-এ একটা একটা করে পুরনো result মুছে prompt-এর শুরু বদলাত (cache ভেঙে যেত)। এখন মোট যা মোছা যাবে সেটা (উঁচু-নিচু সীমার ফাঁকের অর্ধেকের) কম হলে কিছুই ছোঁয় না।
+**DeepSeek-এ টাকা বাঁচানোর আসল উপায়:** Claude Code-এ `CLAUDE_CODE_AUTO_COMPACT_WINDOW` কমানো (উপরে B), অন্য কাজে `/clear`, বড় ফাইল/লগ পুরোটা না পড়া (টুকরো করে পড়া), সস্তা model, আর **fallback-এ অন্য provider-এ যাওয়া কমানো** (প্রতিবার অন্য provider-এ গেলে সেখানকার cache শূন্য, পুরো prompt পুরো দামে)। নিজের provider-এর দামে মাপতে: `npm run bench:tokens`।
+
 ### ৮(ক) আরও ছোট করার দুটো সুইচ (Settings → Context guard)
 - **Also shrink old tool calls** (ডিফল্ট চালু): পুরনো tool output ছাঁটার সময় ওই tool-এর **ডাকের** ভেতরের বড় লেখাও ছোট হয়। যেমন আগের `Write`-এ পুরো ফাইলের লেখা ছিল, এখন থাকে `[router: 9000 characters cleared ...]`; ফাইলের পথ ও বাকি ঘর থাকে।
 - **Shrink big pasted text in old messages** (ডিফল্ট **বন্ধ**, কারণ এটা তোমার নিজের লেখা বদলায়): তোমার পুরনো মেসেজে বিশাল paste (log, ফাইল) থাকলে প্রথম ১৫০০ আর শেষ ৫০০ অক্ষর থাকে। **তোমার প্রথম মেসেজ আর সবচেয়ে নতুন দুটো কখনো ছোঁয়া হয় না।** "A paste counts as big above" ঘরে সীমা (ডিফল্ট ১২,০০০ অক্ষর)।
 
 ### ৮(খ) Router Memory: router নিজে মনে রাখে (Settings → Memory)
-- **কেন:** model-এর স্মৃতি নেই, তাই Claude Code পুরো কথোপকথন আবার পাঠায়। Router memory তার হয়ে মনে রাখে: কথোপকথন লম্বা হলে একটা **সস্তা model** (যেটা তুমি বাছো) **পুরনো মেসেজগুলোর সারাংশ** লেখে। সেটা SQLite-এ জমা থাকে, আর পরের request থেকে পুরনো মেসেজের **বদলে** ওই সারাংশ যায়। প্রতিবার হুবহু একই লেখা যায়, তাই provider-এর cache কাজ করে।
+- **কেন:** model-এর স্মৃতি নেই, তাই Claude Code পুরো কথোপকথন আবার পাঠায়। Router memory তার হয়ে মনে রাখে: কথোপকথন লম্বা হলে একটা **সস্তা model** (যেটা তুমি বাছো) **পুরনো মেসেজগুলোর সারাংশ** লেখে। সেটা SQLite-এ জমা থাকে, আর পরের request থেকে পুরনো মেসেজের **বদলে** ওই সারাংশ যায়। দুটো সারাংশের মাঝে প্রতিবার হুবহু একই লেখা যায়। **মনে রাখো (৮(০)):** এটা token কমায়, কিন্তু cache-সস্তা provider-এ টাকা বাড়াতে পারে, তাই "Auto" নিয়মে সেখানে চলে না।
 - **অপেক্ষা করতে হয় না:** যে request সীমা পার করে সেটা আগের মতোই যায়। সারাংশ **পেছনে** লেখা হয়, পরের request থেকে কাজে লাগে।
 - **নিরাপত্তা:** তোমার আসল প্রথম অনুরোধ হুবহু সারাংশের ভেতরে থাকে। সবচেয়ে নতুন মেসেজগুলো কখনো সারাংশ হয় না। কথোপকথনের শুরু বদলে গেলে (যেমন Claude Code নিজে `/compact` করলে) পুরনো সারাংশ আর লাগানো হয় না। সারাংশ-model ব্যর্থ হলে তোমার request অপরিবর্তিত যায়, আর router ৫ মিনিট পরে আবার চেষ্টা করে।
 - **খরচ ও ঝুঁকি:** প্রতিটা সারাংশে একবার ওই model-এর খরচ (History-তে "router memory summary" নামে দেখা যায়; কিছু লুকানো নেই), আর সারাংশ থেকে ছোটখাটো খুঁটিনাটি হারাতে পারে। তাই আগে **Measure only**।
````

## Verify

```bash
npx tsc --noEmit                    # no output
cd src/web && npx tsc --noEmit && cd ../..    # no output
npm run build                       # built
node scripts/smoke.mjs && node scripts/admin-smoke.mjs && node scripts/guard-smoke.mjs && node scripts/routing-smoke.mjs && node scripts/capacity-smoke.mjs && node scripts/memory-smoke.mjs && node scripts/providers-smoke.mjs && node scripts/optimise-smoke.mjs   # ALL PASSED x8
```
`optimise-smoke.mjs` (12 checks): the default scope is `auto` and invalid values are refused; a cache-priced model's prompt is left untouched; a model with no cache discount, a model with a small cache discount, a model with no price, a provider with a daily quota and a small context window are each shrunk; `always` shrinks a cache-priced model too; history shows no saving when shrinking was skipped; in a text-heavy session the prefix is not rewritten on every request (4 rewrites in 66 requests; the previous code gave 10 on the same test); in a tool-heavy session one big batch still clears 44 of 50 old results.

Then, to see your own numbers: `npm run bench:tokens` (about 2 minutes). Restart the router after applying.
