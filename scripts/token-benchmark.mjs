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
child.kill(); mock.close();
try { fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* Windows may still hold the DB file */ }

const f = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? (n / 1e3).toFixed(0) + "K" : String(Math.round(n)));
const base0 = results[0];
console.log(`\nSession: ${STEPS} requests, tool output = ${(TOOL_SHARE * 100).toFixed(0)}% of growth (assumption). Prices: DeepSeek Flash off-peak, USD per 1M tokens (fresh ${PRICE.fresh}, cache ${PRICE.cache}, output ${PRICE.out}).\n`);
console.log("scenario".padEnd(48), "tokens".padStart(8), "vs A".padStart(6), "fresh".padStart(7), "cache%".padStart(7), "avg".padStart(6), "p90".padStart(6), "max".padStart(6), "$ cached".padStart(9), "vs A".padStart(6), "$ no-cache".padStart(11), "vs A".padStart(6), "sum");
for (const r of results) {
  const pc = (a, b) => (((a / b) - 1) * 100).toFixed(0).padStart(5) + "%";
  console.log(r.name.padEnd(48), f(r.promptTokens).padStart(8), pc(r.promptTokens, base0.promptTokens), f(r.freshTokens).padStart(7), (r.cachePct.toFixed(0) + "%").padStart(7), f(r.avgPrompt).padStart(6), f(r.p90).padStart(6), f(r.maxPrompt).padStart(6), ("$" + r.cost.toFixed(3)).padStart(9), pc(r.cost, base0.cost), ("$" + r.costNoCache.toFixed(3)).padStart(11), pc(r.costNoCache, base0.costNoCache), String(r.summaries).padStart(3));
}
console.log("\nJSON " + JSON.stringify({ toolShare: TOOL_SHARE, steps: STEPS, results }));