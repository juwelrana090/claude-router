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

try { fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* Windows may still hold the DB file */ }
mock.close();
console.log(fails ? `\n${fails} FAILED` : "\nALL PASSED");
process.exit(fails ? 1 : 0);