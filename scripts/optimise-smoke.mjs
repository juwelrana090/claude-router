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
try { fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* Windows may still hold the DB file */ }
mock.close();
console.log(fails ? `\n${fails} FAILED` : "\nALL PASSED");
process.exit(fails ? 1 : 0);