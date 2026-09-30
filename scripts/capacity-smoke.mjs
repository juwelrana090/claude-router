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