// Offline test: live model discovery, "provider/model-id" direct routes, capability refusals.
// Run: npm run build && node scripts/discovery-smoke.mjs
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, "..", "dist", "index.js");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "router-discovery-"));
const PORT = 21995;

// ---- mock OpenAI-style upstream (/v1/models + /v1/chat/completions)
let oaModelsHits = 0;
let lastOaModelsAuth = null;
let lastOA = null;
const oa = http.createServer((req, res) => {
  let data = ""; req.on("data", (c) => (data += c));
  req.on("end", () => {
    if (req.method === "GET" && req.url === "/v1/models") {
      oaModelsHits++; lastOaModelsAuth = req.headers.authorization ?? null;
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ data: [{ id: "mock-beta" }, { id: "mock-alpha" }] }));
    }
    if (req.url !== "/v1/chat/completions") { res.writeHead(404, { "content-type": "application/json" }); return res.end('{"error":{"message":"path not found"}}'); }
    lastOA = { auth: req.headers.authorization ?? null, body: JSON.parse(data || "{}") };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "d1", choices: [{ message: { role: "assistant", content: "openai says hi" }, finish_reason: "stop" }], usage: { prompt_tokens: 9, completion_tokens: 3 } }));
  });
});
await new Promise((r) => oa.listen(0, "127.0.0.1", r));

// ---- mock Anthropic-style upstream (/v1/models answering {models:[{name}]} + /v1/messages)
let anModelsHits = 0;
let lastAnModels = null;
let lastAn = null;
const an = http.createServer((req, res) => {
  let data = ""; req.on("data", (c) => (data += c));
  req.on("end", () => {
    if (req.method === "GET" && req.url === "/v1/models") {
      anModelsHits++;
      lastAnModels = { auth: req.headers.authorization ?? null, xkey: req.headers["x-api-key"] ?? null };
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ models: [{ name: "claude-ish" }] }));
    }
    if (req.url !== "/v1/messages") { res.writeHead(404, { "content-type": "application/json" }); return res.end('{"error":{"message":"path not found"}}'); }
    lastAn = { auth: req.headers.authorization ?? null, body: JSON.parse(data || "{}") };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ type: "message", content: [{ type: "text", text: "from anthropic-style" }], usage: { input_tokens: 10, output_tokens: 5 } }));
  });
});
await new Promise((r) => an.listen(0, "127.0.0.1", r));
const oaBase = `http://127.0.0.1:${oa.address().port}/v1`;
const anBase = `http://127.0.0.1:${an.address().port}`;

fs.writeFileSync(path.join(home, "routes.json"), JSON.stringify({
  defaultModel: "home", aliases: {},
  providers: {
    mocko: { baseURL: oaBase, protocol: "openai", auth: "bearer", keys: ["MOCKO_KEY_1", "MOCKO_KEY_2"] },
    mocka: { baseURL: anBase, auth: "both", keys: ["ANTH2_KEY_1"] },
    // openai protocol against the Anthropic-style mock: /v1/models does not exist there -> discovery 502
    broken: { baseURL: anBase, protocol: "openai", auth: "none" },
  },
  models: {
    home: { provider: "mocko", model: "gpt-oss-up", key: "MOCKO_KEY_1" },
    novision: { provider: "mocko", model: "mock-alpha", capabilities: { vision: false } },
    notools: { provider: "mocka", model: "claude-ish", capabilities: { tools: false } },
  },
}));
fs.writeFileSync(path.join(home, ".env"), `ROUTER_PORT=${PORT}\nROUTER_KEY="secret-router"\nMOCKO_KEY_1=mocko-key-1\nMOCKO_KEY_2=mocko-key-2\nANTH2_KEY_1=an2-key-1\n`);
const child = spawn(process.execPath, [dist], { env: { ...process.env, ROUTER_HOME: home }, stdio: "pipe" });
await new Promise((r) => setTimeout(r, 1300));
const R = `http://127.0.0.1:${PORT}`;
const H = { "content-type": "application/json", "x-api-key": "secret-router", origin: R };
const post = (body) => fetch(R + "/v1/messages", { method: "POST", headers: H, body: JSON.stringify({ max_tokens: 100, ...body }) });
const admin = (p, init = {}) => fetch(R + p, { ...init, headers: { ...H, ...(init.headers || {}) } });
const version = async () => (await (await admin("/admin/models")).json()).version;
let fails = 0;
const t = (n, ok, x = "") => { console.log((ok ? "PASS " : "FAIL ") + n + (x ? "  " + x : "")); if (!ok) fails++; };

const tools = [{ name: "get_weather", description: "weather", input_schema: { type: "object", properties: { city: { type: "string" } } } }];

// ---------- 1. discovery on an OpenAI-style provider normalizes {data:[{id}]}
let r = await admin("/admin/providers/mocko/models");
let j = await r.json();
t("discovery: OpenAI-style GET {baseURL}/models returns normalized ids", r.status === 200 && j.provider === "mocko" && j.models.length === 2 && j.models.includes("mock-beta") && j.models.includes("mock-alpha"), JSON.stringify(j));
t("discovery: sent with a key from the pool", lastOaModelsAuth === "Bearer mocko-key-1" || lastOaModelsAuth === "Bearer mocko-key-2", String(lastOaModelsAuth));
t("discovery: upstream hit once", oaModelsHits === 1);
r = await admin("/admin/providers/mocko/models");
await r.json();
t("discovery: second call served from the TTL cache (no new upstream hit)", oaModelsHits === 1);

// ---------- 2. discovery on an Anthropic-style provider hits /v1/models and normalizes {models:[{name}]}
r = await admin("/admin/providers/mocka/models");
j = await r.json();
t("discovery: Anthropic-style GET {baseURL}/v1/models, {models:[{name}]} shape normalized", r.status === 200 && j.models.length === 1 && j.models[0] === "claude-ish" && anModelsHits === 1, JSON.stringify(j));
t("discovery: auth \"both\" sends both header styles", lastAnModels.auth === "Bearer an2-key-1" && lastAnModels.xkey === "an2-key-1");

// ---------- 3. discovery failures become 502, unknown providers 404
r = await admin("/admin/providers/broken/models");
j = await r.json();
t("discovery: upstream without a model list -> 502 with the reason", r.status === 502 && j.error.type === "api_error" && /Model discovery failed.*HTTP 404/.test(j.error.message), JSON.stringify(j.error?.message));
r = await admin("/admin/providers/ghost/models");
t("discovery: unknown provider -> 404", r.status === 404);

// ---------- 4. "provider/model-id" direct routes
r = await post({ model: "mocko/mock-beta", messages: [{ role: "user", content: "hi" }] });
j = await r.json();
t("direct route: openai-style provider gets the bare model id", r.status === 200 && lastOA.body.model === "mock-beta" && j.content[0].text === "openai says hi", lastOA.body.model);
t("direct route: uses the provider's whole key pool", /^Bearer mocko-key-[12]$/.test(lastOA.auth ?? ""), String(lastOA.auth));
r = await post({ model: "mocka/claude-ish", messages: [{ role: "user", content: "hi" }] });
j = await r.json();
t("direct route: anthropic-style provider gets the bare model id", r.status === 200 && lastAn.body.model === "claude-ish" && j.content[0].text === "from anthropic-style", String(lastAn.body.model));
r = await post({ model: "unknownprov/whatever", messages: [{ role: "user", content: "hi" }] });
j = await r.json();
t("unknown provider prefix falls back to the default model", r.status === 200 && lastOA.body.model === "gpt-oss-up", lastOA.body.model);

// ---------- 5. capability refusals
r = await post({ model: "novision", messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }, { type: "text", text: "what is this" }] }] });
j = await r.json();
t("capabilities: vision:false + image block -> 400 with a clear message", r.status === 400 && j.error.type === "invalid_request_error" && /does not support images/.test(j.error.message), JSON.stringify(j.error?.message));
r = await post({ model: "notools", tools, messages: [{ role: "user", content: "weather in Dhaka" }] });
j = await r.json();
t("capabilities: tools:false + tools -> 400 with a clear message", r.status === 400 && j.error.type === "invalid_request_error" && /does not support tools/.test(j.error.message), JSON.stringify(j.error?.message));
r = await post({ model: "home", tools, messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }, { type: "text", text: "hi" }] }] });
j = await r.json();
t("capabilities: absent flags assume supported (tools + image pass)", r.status === 200 && lastOA.body.model === "gpt-oss-up");
r = await post({ model: "novision", messages: [{ role: "user", content: "plain text is fine" }] });
t("capabilities: vision:false without images still passes", r.status === 200);

// ---------- 6. capabilities round-trip through the admin API
let ms = (await (await admin("/admin/models")).json()).models;
const byAlias = (list, alias) => list.find((x) => x.alias === alias);
t("admin: capabilities stored on the model", byAlias(ms, "novision")?.capabilities?.vision === false, JSON.stringify(byAlias(ms, "novision")?.capabilities));
let v = await version();
r = await admin("/admin/models/novision", { method: "PUT", body: JSON.stringify({ version: v, capabilities: { tools: "maybe" } }) });
t("admin: non-boolean capability refused", r.status === 400 && /true or false/.test(await r.text()));
v = await version();
r = await admin("/admin/models/novision", { method: "PUT", body: JSON.stringify({ version: v, capabilities: null }) });
ms = (await (await admin("/admin/models")).json()).models;
t("admin: null clears capabilities", r.status === 200 && byAlias(ms, "novision")?.capabilities === undefined);

child.kill();
try { fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* Windows may still hold the DB file */ }
oa.close(); an.close();
console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
