// Offline smoke test: mock upstream providers, real router process. Run: npm run build && npm run smoke
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, "..", "dist", "index.js");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "router-"));
const seen = [];

// ---- mock upstream: behaviour depends on the API key ----
const mock = http.createServer((req, res) => {
  let data = "";
  req.on("data", (c) => (data += c));
  req.on("end", () => {
    const body = JSON.parse(data || "{}");
    const key = (req.headers["x-api-key"] || String(req.headers.authorization || "").replace("Bearer ", ""));
    seen.push({ url: req.url, key, model: body.model, max_tokens: body.max_tokens });
    if (key === "K-RATELIMIT") { res.writeHead(429, { "retry-after": "30" }); return res.end('{"error":"rl"}'); }
    if (key === "K-DEAD") { res.writeHead(500); return res.end('{"error":"boom"}'); }
    if (body.stream) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":120,"cache_read_input_tokens":100,"output_tokens":1}}}\n\n');
      res.write('event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":42}}\n\n');
      return res.end('event: message_stop\ndata: {"type":"message_stop"}\n\n');
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ type: "message", content: [{ type: "text", text: "ok" }], usage: { input_tokens: 10, output_tokens: 5 } }));
  });
});
await new Promise((r) => mock.listen(0, "127.0.0.1", r));
const mport = mock.address().port;
const base = `http://127.0.0.1:${mport}`;

fs.writeFileSync(path.join(home, "routes.json"), JSON.stringify({
  aliases: { sonnet: "a" },
  providers: {
    p1: { baseURL: base, auth: "bearer", keys: ["P1_K1", "P1_K2"] },
    p2: { baseURL: base, auth: "x-api-key", keys: ["P2_K1"] },
  },
  models: {
    a:     { provider: "p1", model: "real-a", maxOutputTokens: 1000, fallback: ["b"] },
    b:     { provider: "p2", model: "real-b" },
    dead:  { provider: "p2", model: "real-dead", key: "P2_DEAD", fallback: ["b"] },
    pin:   { provider: "p1", model: "real-pin", key: "P1_K2" },
  },
}));
fs.writeFileSync(path.join(home, ".env"),
  `ROUTER_PORT=21999\nROUTER_KEY="secret-router"\nP1_K1="K-RATELIMIT"\nP1_K2='K-GOOD'\nP2_K1=K-P2 # comment\nP2_DEAD=K-DEAD\n`);

const child = spawn(process.execPath, [dist], { env: { ...process.env, ROUTER_HOME: home }, stdio: "pipe" });
let log = ""; child.stdout.on("data", (d) => (log += d)); child.stderr.on("data", (d) => (log += d));
await new Promise((r) => setTimeout(r, 800));

const R = "http://127.0.0.1:21999";
const H = { "content-type": "application/json", authorization: "Bearer secret-router" };
const post = (p, b, h = H) => fetch(R + p, { method: "POST", headers: h, body: JSON.stringify(b) });
let fails = 0;
const t = (name, ok) => { console.log((ok ? "PASS " : "FAIL ") + name); if (!ok) fails++; };

t("health (no auth)", (await fetch(R + "/health")).status === 200);
t("rejects bad router key", (await post("/v1/messages", { model: "a" }, { ...H, authorization: "Bearer nope" })).status === 401);
t("accepts x-api-key router auth", (await post("/v1/messages", { model: "pin", max_tokens: 5 }, { "content-type": "application/json", "x-api-key": "secret-router" })).status === 200);

seen.length = 0;
let r = await post("/v1/messages?beta=true", { model: "claude-sonnet-4-5", max_tokens: 99999, messages: [] });
t("?beta=true path + claude-* alias -> 200", r.status === 200);
const first = seen.filter((s) => s.model === "real-a");
t("model rewritten + max_tokens clamped to 1000", first.length > 0 && first.every((s) => s.max_tokens === 1000));
seen.length = 0;
const codes = [];
for (let i = 0; i < 8; i++) codes.push((await post("/v1/messages", { model: "a", system: "seed-" + i, messages: [] })).status);
t("429 on one pooled key -> next key, client always sees 200", codes.every((c) => c === 200) && seen.some((s) => s.key === "K-RATELIMIT"));

seen.length = 0;
r = await post("/v1/messages", { model: "dead", messages: [] });
t("500 on pinned key -> fallback route", r.status === 200 && seen.at(-1).model === "real-b");

r = await post("/v1/messages", { model: "no-such-model", messages: [] });
t("unknown model -> clear 400 (no silent routing)", r.status === 400 && (await r.text()).includes("Available"));

r = await post("/v1/messages", { model: "pin", stream: true, messages: [] });
const txt = await r.text();
t("streaming passthrough", txt.includes("message_stop"));
await new Promise((x) => setTimeout(x, 100));
const usage = await (await fetch(R + "/admin/usage", { headers: H })).json();
t("stream usage sniffed (delta: in+120 out+42 cacheRead+100)", usage.pin?.in === 130 && usage.pin?.out === 47 && usage.pin?.cacheRead === 100);

r = await post("/v1/messages/count_tokens", { messages: [{ role: "user", content: "hello world" }] });
t("count_tokens local estimate", r.status === 200 && (await r.json()).input_tokens > 0);

const st = await (await fetch(R + "/admin/status", { headers: H })).json();
t("status never leaks key values", !JSON.stringify(st).includes("K-GOOD"));

child.kill(); mock.close();
console.log(fails ? `\n${fails} FAILED\n${log}` : "\nALL PASSED");
process.exit(fails ? 1 : 0);
