// Offline test: OpenAI-style providers, the catalog, and address mistakes (Ollama /api).
// Run: npm run build && node scripts/providers-smoke.mjs
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, "..", "dist", "index.js");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "router-providers-"));
const PORT = 21990;

// ---- mock OpenAI-style upstream (/chat/completions) and mock Anthropic-style upstream (/v1/messages)
let lastOpenAI = null;
let openAIFail = 0; // answer 429 this many times
const sse = (res, chunks) => { res.writeHead(200, { "content-type": "text/event-stream" }); for (const c of chunks) res.write(`data: ${typeof c === "string" ? c : JSON.stringify(c)}\n\n`); res.end(); };
const oa = http.createServer((req, res) => {
  let data = ""; req.on("data", (c) => (data += c));
  req.on("end", () => {
    if (req.url !== "/v1/chat/completions") { res.writeHead(404, { "content-type": "application/json" }); return res.end('{"error":{"message":"path not found"}}'); }
    const body = JSON.parse(data || "{}");
    lastOpenAI = { auth: req.headers.authorization ?? null, xkey: req.headers["x-api-key"] ?? null, body };
    if (openAIFail > 0) { openAIFail--; res.writeHead(429, { "content-type": "application/json" }); return res.end('{"error":{"message":"Insufficient balance, please recharge"}}'); }
    const tools = Array.isArray(body.tools) && body.tools.length;
    const lastUser = body.messages[body.messages.length - 1];
    if (body.stream) {
      if (tools && /weather/i.test(JSON.stringify(body.messages)) && lastUser.role !== "tool") {
        return sse(res, [
          { id: "c1", choices: [{ index: 0, delta: { role: "assistant", content: "Let me check. " } }] },
          { id: "c1", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_abc", type: "function", function: { name: "get_weather", arguments: "" } }] } }] },
          { id: "c1", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"city":' } }] } }] },
          { id: "c1", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"Dhaka"}' } }] } }] },
          { id: "c1", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
          { id: "c1", choices: [], usage: { prompt_tokens: 120, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 100 } } },
          "[DONE]",
        ]);
      }
      return sse(res, [
        { id: "c2", choices: [{ index: 0, delta: { role: "assistant", content: "Hello" } }] },
        { id: "c2", choices: [{ index: 0, delta: { content: " world" } }] },
        { id: "c2", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
        { id: "c2", choices: [], usage: { prompt_tokens: 50, completion_tokens: 2 } },
        "[DONE]",
      ]);
    }
    res.writeHead(200, { "content-type": "application/json" });
    if (tools && lastUser.role !== "tool" && /weather/i.test(JSON.stringify(body.messages))) {
      return res.end(JSON.stringify({ id: "x1", choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"Dhaka"}' } }] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 80, completion_tokens: 12 } }));
    }
    res.end(JSON.stringify({ id: "x2", choices: [{ message: { role: "assistant", content: "Sunny in Dhaka. " + "summary ".repeat(12) }, finish_reason: "stop" }], usage: { prompt_tokens: 90, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 30 } } }));
  });
});
await new Promise((r) => oa.listen(0, "127.0.0.1", r));
let lastAnth = null;
const an = http.createServer((req, res) => {
  let data = ""; req.on("data", (c) => (data += c));
  req.on("end", () => {
    lastAnth = { url: req.url, auth: req.headers.authorization ?? null, xkey: req.headers["x-api-key"] ?? null };
    let asked = "";
    try { asked = JSON.parse(data || "{}").model ?? ""; } catch { /* not json */ }
    if (asked === "wrong-endpoint") {
      res.writeHead(400, { "content-type": "application/json" });
      return res.end('{"error":{"type":"invalid_request_error","message":"Wrong endpoint for model wrong-endpoint: non-Anthropic models are served on /v1/chat/completions"}}');
    }
    if (asked === "needs-upgrade") {
      res.writeHead(403, { "content-type": "application/json" });
      return res.end('{"error":{"type":"permission_error","message":"upgrade_required: you are on the Go plan, the only plan without API access"}}');
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ type: "message", content: [{ type: "text", text: "from anthropic-style" }], usage: { input_tokens: 10, output_tokens: 5 } }));
  });
});
await new Promise((r) => an.listen(0, "127.0.0.1", r));
const oaBase = `http://127.0.0.1:${oa.address().port}/v1`;
const anBase = `http://127.0.0.1:${an.address().port}`;

fs.writeFileSync(path.join(home, "routes.json"), JSON.stringify({
  defaultModel: "free", aliases: {},
  providers: {
    groq: { baseURL: oaBase, protocol: "openai", auth: "bearer", keys: ["GROQ_KEY_1"] },
    anth: { baseURL: anBase, auth: "both", keys: ["ANTH_KEY_1"] },
  },
  models: {
    free: { provider: "groq", model: "gpt-oss-up", key: "GROQ_KEY_1", fallback: ["paid"] },
    paid: { provider: "anth", model: "claude-like", key: "ANTH_KEY_1" },
  },
}));
fs.writeFileSync(path.join(home, ".env"), `ROUTER_PORT=${PORT}\nROUTER_KEY="secret-router"\nGROQ_KEY_1=gsk-test-1111\nANTH_KEY_1=an-test-2222\n`);
const child = spawn(process.execPath, [dist], { env: { ...process.env, ROUTER_HOME: home }, stdio: "pipe" });
await new Promise((r) => setTimeout(r, 1300));
const R = `http://127.0.0.1:${PORT}`;
const H = { "content-type": "application/json", "x-api-key": "secret-router", origin: R };
const post = (body) => fetch(R + "/v1/messages", { method: "POST", headers: H, body: JSON.stringify({ max_tokens: 100, ...body }) });
const admin = (p, init = {}) => fetch(R + p, { ...init, headers: { ...H, ...(init.headers || {}) } });
const version = async () => (await (await admin("/admin/models")).json()).version;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const t = (n, ok, x = "") => { console.log((ok ? "PASS " : "FAIL ") + n + (x ? "  " + x : "")); if (!ok) fails++; };
const events = (txt) => txt.split("\n\n").filter(Boolean).map((b) => { const ev = b.match(/^event: (.+)$/m)?.[1]; const d = JSON.parse(b.match(/^data: (.+)$/m)[1]); return { ev, d }; });

const tools = [{ name: "get_weather", description: "weather", input_schema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } }];

// ---------- 1. plain request to an OpenAI-style provider
let r = await post({ model: "free", system: [{ type: "text", text: "You are helpful." }], messages: [{ role: "user", content: [{ type: "text", text: "hi there" }] }], temperature: 0.2, stop_sequences: ["END"], thinking: { type: "enabled", budget_tokens: 100 } });
let j = await r.json();
t("OpenAI-style provider answers in Claude's format", r.status === 200 && j.type === "message" && j.role === "assistant" && /Sunny in Dhaka/.test(j.content[0].text) && j.stop_reason === "end_turn");
t("usage converted (cached tokens split out)", j.usage.input_tokens === 60 && j.usage.cache_read_input_tokens === 30 && j.usage.output_tokens === 20, JSON.stringify(j.usage));
const sent = lastOpenAI.body;
t("request converted: model, system message, user text, max_tokens, temperature, stop", sent.model === "gpt-oss-up" && sent.messages[0].role === "system" && sent.messages[0].content === "You are helpful." && sent.messages[1].content === "hi there" && sent.max_tokens === 100 && sent.temperature === 0.2 && sent.stop[0] === "END");
t("Claude-only fields are not sent (thinking, metadata)", sent.thinking === undefined && sent.metadata === undefined);
t("sent with Bearer only (no x-api-key)", lastOpenAI.auth === "Bearer gsk-test-1111" && lastOpenAI.xkey === null);

// ---------- 2. tool call round trip (non-streaming)
const toolConv = [{ role: "user", content: "What is the weather in Dhaka?" }];
r = await post({ model: "free", tools, tool_choice: { type: "auto" }, messages: toolConv });
j = await r.json();
const tu = j.content.find((b) => b.type === "tool_use");
t("tool call comes back as a tool_use block with parsed input", tu && tu.name === "get_weather" && tu.input.city === "Dhaka" && tu.id === "call_1" && j.stop_reason === "tool_use");
t("tools sent as functions with the schema, tool_choice auto", lastOpenAI.body.tools[0].type === "function" && lastOpenAI.body.tools[0].function.parameters.required[0] === "city" && lastOpenAI.body.tool_choice === "auto");
r = await post({ model: "free", tools, messages: [...toolConv, { role: "assistant", content: [{ type: "text", text: "checking" }, { type: "tool_use", id: "call_1", name: "get_weather", input: { city: "Dhaka" } }] }, { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "31 C, sunny" }, { type: "text", text: "thanks" }] }] });
await r.json();
const m2 = lastOpenAI.body.messages;
const ai = m2.findIndex((x) => x.role === "assistant");
t("tool call + tool result converted in the right order", m2[ai].tool_calls[0].function.arguments === '{"city":"Dhaka"}' && m2[ai + 1].role === "tool" && m2[ai + 1].tool_call_id === "call_1" && m2[ai + 1].content === "31 C, sunny" && m2[ai + 2].role === "user" && m2[ai + 2].content === "thanks", JSON.stringify(m2.map((x) => x.role)));

// ---------- 3. streaming
r = await post({ model: "free", stream: true, messages: [{ role: "user", content: "say hello" }] });
let ev = events(await r.text());
t("stream: same event order as Claude's API", ev.map((e) => e.ev).join(",") === "message_start,content_block_start,content_block_delta,content_block_delta,content_block_stop,message_delta,message_stop", ev.map((e) => e.ev).join(","));
t("stream: text arrives as text_delta pieces", ev.filter((e) => e.ev === "content_block_delta").map((e) => e.d.delta.text).join("") === "Hello world");
t("stream: stop reason and usage", ev.at(-2).d.delta.stop_reason === "end_turn" && ev.at(-2).d.usage.output_tokens === 2 && ev.at(-2).d.usage.input_tokens === 50);
t("stream: include_usage was requested", lastOpenAI.body.stream === true && lastOpenAI.body.stream_options.include_usage === true);
r = await post({ model: "free", stream: true, tools, messages: [{ role: "user", content: "weather in Dhaka please" }] });
ev = events(await r.text());
const starts = ev.filter((e) => e.ev === "content_block_start");
t("stream with tool call: a text block then a tool_use block", starts.length === 2 && starts[0].d.content_block.type === "text" && starts[1].d.content_block.type === "tool_use" && starts[1].d.content_block.id === "call_abc" && starts[1].d.content_block.name === "get_weather");
t("stream with tool call: arguments arrive as input_json_delta that joins to valid JSON", JSON.parse(ev.filter((e) => e.d.delta?.type === "input_json_delta").map((e) => e.d.delta.partial_json).join("")).city === "Dhaka");
t("stream with tool call: stop_reason tool_use, cache split", ev.at(-2).d.delta.stop_reason === "tool_use" && ev.at(-2).d.usage.cache_read_input_tokens === 100 && ev.at(-2).d.usage.input_tokens === 20);
t("stream: blocks are closed before the next opens", (() => { let open = -1; for (const e of ev) { if (e.ev === "content_block_start") { if (open !== -1) return false; open = e.d.index; } if (e.ev === "content_block_stop") { if (open !== e.d.index) return false; open = -1; } } return open === -1; })());

// ---------- 4. history + failover from an OpenAI-style provider to an Anthropic-style one
await sleep(300);
let rows = (await (await admin("/admin/requests?limit=3&q=free")).json()).rows;
t("history records tokens for OpenAI-style requests", rows.length && rows[0].in >= 0 && rows[0].provider === "groq");
openAIFail = 1;
r = await post({ model: "free", messages: [{ role: "user", content: "hi" }] });
j = await r.json();
t("free provider out of balance: falls over to the Anthropic-style provider", r.status === 200 && j.content[0].text === "from anthropic-style" && r.headers.get("x-router-served") === "paid");
t("... and the Anthropic-style provider was called the normal way", lastAnth.url === "/v1/messages" && lastAnth.auth === "Bearer an-test-2222" && lastAnth.xkey === "an-test-2222");
await sleep(250);
rows = (await (await admin("/admin/requests?limit=1")).json()).rows;
t("... and the reason is in the trace", rows[0].trace.some((x) => x.outcome === "failed" && /Insufficient balance/.test(x.detail ?? "")));

// ---------- 5. connection test works for both protocols and gives hints
await admin("/admin/keys/GROQ_KEY_1/reset-cooldown", { method: "POST", body: "{}" });
let tr = await (await admin("/admin/models/free/test", { method: "POST", body: JSON.stringify({ confirm: true }) })).json();
t("model test works on an OpenAI-style provider", tr.ok === true && tr.status === 200, JSON.stringify({ ok: tr.ok, status: tr.status }));

// ---------- 6. address mistakes are refused, with the reason
let v = await version();
const put = (name, b) => admin("/admin/providers/" + name, { method: "PUT", body: JSON.stringify({ version: v, ...b }) });
let pr = await put("anth", { baseURL: anBase + "/v1" });
t("Anthropic-style address ending in /v1 is refused", pr.status === 400 && /remove \/v1/.test(await pr.text()));
pr = await put("anth", { baseURL: anBase + "/v1/messages" });
t("address ending in /v1/messages is refused", pr.status === 400 && /adds the final part itself/.test(await pr.text()));
pr = await put("groq", { baseURL: oaBase + "/chat/completions" });
t("address ending in /chat/completions is refused", pr.status === 400);
pr = await admin("/admin/providers", { method: "POST", body: JSON.stringify({ version: v, name: "ollama", baseURL: "https://ollama.com/api", auth: "bearer" }) });
t("the Ollama mistake (https://ollama.com/api) is refused with the right address", pr.status === 400 && /https:\/\/ollama\.com \(without \/api\)/.test(await pr.text()));
pr = await put("groq", { baseURL: oaBase, protocol: "banana" });
t("unknown protocol refused", pr.status === 400);
pr = await put("anth", { protocol: "openai", baseURL: anBase + "/v1" });
t("OpenAI-style address may end in /v1", pr.status === 200);
v = await version();
pr = await put("anth", { protocol: "anthropic", baseURL: anBase });
t("switching back works", pr.status === 200);

// ---------- 7. catalog
let cat = await (await admin("/admin/catalog")).json();
t("catalog lists the providers with protocol, address and where to get a key", cat.entries.length >= 12 && cat.entries.every((e) => e.baseURL && e.protocol && e.steps.length && e.verified) && cat.entries.some((e) => e.tier === "free") && cat.entries.some((e) => e.tier === "cheap"));
const ollama = cat.entries.find((e) => e.id === "ollama-cloud");
t("catalog has the correct Ollama cloud address and no /api", ollama.baseURL === "https://ollama.com" && ollama.auth === "bearer");
t("every catalog address passes the router's own address check", cat.entries.every((e) => !/\/v1\/messages$|\/chat\/completions$/.test(e.baseURL)) && cat.entries.filter((e) => e.protocol === "anthropic").every((e) => !/\/v1$/.test(e.baseURL)));
v = cat.version;
pr = await admin("/admin/catalog/add", { method: "POST", body: JSON.stringify({ version: v, id: "ollama-cloud", key: "ollama-secret-7777", models: [{ id: "deepseek-v4.1-flash" }, { id: "glm-5.3-flash", alias: "my-glm-flash" }] }) });
let aj = await pr.json();
t("add from catalog: provider + key + 2 models in one save", pr.status === 201 && aj.provider.name === "ollama-cloud" && aj.models.length === 2 && aj.models.includes("my-glm-flash"), JSON.stringify({ s: pr.status, m: aj.models }));
t("... key stored in .env, pool updated, secret not echoed", fs.readFileSync(path.join(home, ".env"), "utf8").includes("OLLAMA_CLOUD_KEY_1=ollama-secret-7777") && aj.provider.keys[0].envName === "OLLAMA_CLOUD_KEY_1" && !JSON.stringify(aj).includes("ollama-secret-7777"));
const mods = (await (await admin("/admin/models")).json()).models;
const dsm = mods.find((m) => m.model === "deepseek-v4.1-flash");
t("... models created with catalog prices", dsm.price && dsm.price.in === 0.30 && dsm.price.out === 1.20 && dsm.alias === "deepseek-v4.1-flash");
cat = await (await admin("/admin/catalog")).json();
t("catalog now shows it as installed with its models", cat.entries.find((e) => e.id === "ollama-cloud").installed === "ollama-cloud" && cat.entries.find((e) => e.id === "ollama-cloud").addedModels.includes("glm-5.3-flash"));
pr = await admin("/admin/catalog/add", { method: "POST", body: JSON.stringify({ version: cat.version, id: "ollama-cloud", models: ["deepseek-v4.1-flash"] }) });
aj = await pr.json();
t("adding the same model again gets a fresh alias, provider reused", pr.status === 201 && aj.models[0] === "deepseek-v4.1-flash-2" && aj.provider.keys.length === 1);
pr = await admin("/admin/catalog/add", { method: "POST", body: JSON.stringify({ version: (await version()), id: "openrouter", models: ["openrouter/free"] }) });
aj = await pr.json();
t("free tier suggestion applied: OpenRouter gets a daily limit of 50 requests", pr.status === 201 && aj.provider.dailyRequests === 50 && /No key yet/.test(aj.warning ?? ""), JSON.stringify({ d: aj.provider?.dailyRequests, w: aj.warning }));
pr = await admin("/admin/catalog/add", { method: "POST", body: JSON.stringify({ version: await version(), id: "groq", providerName: "groq2", key: "gsk-second-3333", models: ["openai/gpt-oss-120b"] }) });
aj = await pr.json();
t("OpenAI-style catalog entry creates an openai-protocol provider", pr.status === 201 && aj.provider.protocol === "openai" && aj.provider.baseURL === "https://api.groq.com/openai/v1");
pr = await admin("/admin/catalog/add", { method: "POST", body: JSON.stringify({ version: await version(), id: "groq", providerName: "groq", models: ["x"] }) });
t("a provider name already used for a different address is refused", pr.status === 400 && /already exists with another address/.test(await pr.text()));
pr = await admin("/admin/catalog/add", { method: "POST", body: JSON.stringify({ version: await version(), id: "ollama-local", key: "abcdefgh", models: ["qwen3-coder"] }) });
t("keyless provider refuses a key", pr.status === 400 && /needs no key/.test(await pr.text()));
pr = await admin("/admin/catalog/add", { method: "POST", body: JSON.stringify({ version: await version(), id: "ollama-local", models: ["qwen3-coder"] }) });
aj = await pr.json();
t("Ollama on your computer: no key needed, created with auth none", pr.status === 201 && aj.provider.keyless === true && aj.warning === null, JSON.stringify({ s: pr.status, k: aj.provider?.keyless }));
pr = await admin("/admin/catalog/add", { method: "POST", body: JSON.stringify({ version: await version(), id: "nope", models: ["x"] }) });
t("unknown catalog entry -> 404", pr.status === 404);
pr = await admin("/admin/catalog/add", { method: "POST", body: JSON.stringify({ version: await version(), id: "gemini", models: [] }) });
t("no model chosen -> clear error", pr.status === 400 && /choose at least one model/.test(await pr.text()));
const after = (await (await admin("/admin/models")).json()).models.map((m) => m.alias);
// ---------- 7b. Command Code: the card, the address message, the hints
{
  const cc = cat.entries.find((e) => e.id === "commandcode");
  const ccl = cat.entries.find((e) => e.id === "commandcode-claude");
  t("Command Code card (open models) is OpenAI style on /provider/v1 with Bearer auth", cc && cc.protocol === "openai" && cc.baseURL === "https://api.commandcode.ai/provider/v1" && cc.auth === "bearer");
  t("... it lists the docs-confirmed free model id and no Claude models (those are only served on /v1/messages)", cc.models.some((m) => m.id === "stealth/space-bunny-alpha" && m.free) && cc.models.every((m) => !/^claude-/i.test(m.id)));
  t("Command Code Claude card is Claude format on /provider and lists only Claude ids", ccl && ccl.protocol === "anthropic" && ccl.baseURL === "https://api.commandcode.ai/provider" && ccl.models.length > 0 && ccl.models.every((m) => /^claude-/.test(m.id)));
  const vv = await version();
  const pe = await admin("/admin/providers/groq", { method: "PUT", body: JSON.stringify({ version: vv, baseURL: "https://api.commandcode.ai/provider/v1/chat/completions" }) });
  const pet = await pe.text();
  t("a pasted .../chat/completions address is refused and the message says what to type", pe.status === 400 && /https:\/\/api\.commandcode\.ai\/provider\/v1/.test(pet) && /OpenAI style/.test(pet), pet.slice(0, 200));
  const pm = await admin("/admin/providers/anth", { method: "PUT", body: JSON.stringify({ version: vv, baseURL: "https://api.commandcode.ai/provider/v1/messages" }) });
  t("a pasted .../v1/messages address is refused with the corrected address", pm.status === 400 && /use https:\/\/api\.commandcode\.ai\/provider /.test(await pm.text()));
  let mv = await version();
  await admin("/admin/models", { method: "POST", body: JSON.stringify({ version: mv, alias: "wrongep", provider: "anth", model: "wrong-endpoint", key: "ANTH_KEY_1" }) });
  mv = await version();
  await admin("/admin/models", { method: "POST", body: JSON.stringify({ version: mv, alias: "needsup", provider: "anth", model: "needs-upgrade", key: "ANTH_KEY_1" }) });
  const hw = await (await admin("/admin/models/wrongep/test", { method: "POST", body: JSON.stringify({ confirm: true }) })).json();
  t("test on a model behind the wrong endpoint: hint explains Claude-only vs OpenAI format", hw.ok === false && /Provider speaks/.test(hw.hint ?? "") && /Claude models only in Claude format/.test(hw.hint ?? ""), hw.hint?.slice(0, 80));
  const hu = await (await admin("/admin/models/needsup/test", { method: "POST", body: JSON.stringify({ confirm: true }) })).json();
  t("test on a plan without API access: hint says the plan has no API access", hu.ok === false && /no API access/.test(hu.hint ?? ""), hu.hint?.slice(0, 80));
}
t("failed adds left nothing behind", !after.includes("x") && !(await (await admin("/admin/providers")).json()).providers.some((p) => p.name === "gemini"));

// ---------- 8. a free OpenAI-style model can be the one that writes the memory summaries
await admin("/admin/keys/GROQ_KEY_1/reset-cooldown", { method: "POST", body: "{}" });
pr = await admin("/admin/app-settings", { method: "PUT", body: JSON.stringify({ settings: { "memory.model": "free", "memory.mode": "on", "memory.highTokens": 30000, "memory.lowTokens": 12000, "guard.mode": "off" } }) });
t("memory can be pointed at an OpenAI-style model", pr.status === 200);
const long = [{ role: "user", content: [{ type: "text", text: "Refactor the billing module." }] }];
for (let i = 0; i < 40; i++) {
  long.push({ role: "assistant", content: [{ type: "tool_use", id: "t" + i, name: "Read", input: { file_path: `/src/f${i}.ts` } }] });
  long.push({ role: "user", content: [{ type: "tool_result", tool_use_id: "t" + i, content: "z".repeat(5000) }] });
}
await post({ model: "paid", system: "S".repeat(4000), messages: long, metadata: { user_id: "prov-mem" } });
await sleep(900);
const mem = await (await admin("/admin/memory")).json();
t("summary written through the OpenAI-style provider and stored", mem.summaries.length === 1 && mem.summaries[0].model === "free" && /Sunny in Dhaka/.test(mem.summaries[0].summary) && /Original request:\nRefactor the billing module/.test(mem.summaries[0].summary));
t("the summariser request was converted (system + user text, no Claude-only fields)", lastOpenAI.body.messages[0].role === "system" && lastOpenAI.body.messages[1].role === "user" && lastOpenAI.body.stream === undefined);

child.kill();
try { fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* Windows may still hold the DB file */ }
oa.close(); an.close();
console.log(fails ? `\n${fails} FAILED` : "\nALL PASSED");
process.exit(fails ? 1 : 0);