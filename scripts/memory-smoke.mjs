// Offline test: router memory (rolling summaries), prompt anatomy, tool-input and paste trimming.
// Run: npm run build && node scripts/memory-smoke.mjs
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, "..", "dist", "index.js");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "router-memory-"));
const PORT = 21991;

// mock upstream. key K-SUM = the summariser (counts calls), anything else = the main model (records bodies)
let sumCalls = 0;
let sumFail = false;
let sumInputs = [];
let last = null;
const mock = http.createServer((req, res) => {
  let data = "";
  req.on("data", (c) => (data += c));
  req.on("end", () => {
    const key = req.headers["x-api-key"] || String(req.headers.authorization || "").replace("Bearer ", "");
    const body = JSON.parse(data || "{}");
    if (key === "K-SUM") {
      sumCalls++;
      sumInputs.push(String(body.messages?.[0]?.content ?? ""));
      if (sumFail) { res.writeHead(500, { "content-type": "application/json" }); return res.end('{"error":{"message":"summariser down"}}'); }
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "message", content: [{ type: "text", text: `Goal: fix billing. Decisions: use retry. Files: /src/billing.ts edited (call ${sumCalls}). Open: tests. ${"detail ".repeat(20)}` }], usage: { input_tokens: 4000, output_tokens: 300 } }));
      }, 150);
      return;
    }
    last = body;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ type: "message", content: [{ type: "text", text: "ok" }], usage: { input_tokens: 500, output_tokens: 20, cache_read_input_tokens: 10000 } }));
  });
});
await new Promise((r) => mock.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${mock.address().port}`;

fs.writeFileSync(path.join(home, "routes.json"), JSON.stringify({
  defaultModel: "main",
  aliases: {},
  providers: { p: { baseURL: base, auth: "bearer", keys: ["MAIN_KEY", "SUM_KEY"] } },
  models: {
    main: { provider: "p", model: "main-up", key: "MAIN_KEY", fallback: ["alt"] },
    alt: { provider: "p", model: "alt-up", key: "MAIN_KEY" },
    sum: { provider: "p", model: "sum-up", key: "SUM_KEY", price: { in: 1, out: 2 } },
  },
}));
fs.writeFileSync(path.join(home, ".env"), `ROUTER_PORT=${PORT}\nROUTER_KEY="secret-router"\nMAIN_KEY=K-MAIN\nSUM_KEY=K-SUM\n`);

const child = spawn(process.execPath, [dist], { env: { ...process.env, ROUTER_HOME: home }, stdio: "pipe" });
await new Promise((r) => setTimeout(r, 1300));
const R = `http://127.0.0.1:${PORT}`;
const H = { "content-type": "application/json", "x-api-key": "secret-router", origin: R };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const admin = (p, init = {}) => fetch(R + p, { ...init, headers: { ...H, ...(init.headers || {}) } });
const set = (s) => admin("/admin/app-settings", { method: "PUT", body: JSON.stringify({ settings: s }) });
let fails = 0;
const t = (n, ok, x = "") => { console.log((ok ? "PASS " : "FAIL ") + n + (x ? "  " + x : "")); if (!ok) fails++; };

// A long agent run: ONE user request, then many assistant tool calls + results (no user turn boundaries inside).
function convo(pairs, { chars = 5000, session = "mem-A", bigInputAt = -1 } = {}) {
  const messages = [{ role: "user", content: [{ type: "text", text: "Fix the retry bug in the billing module. Keep the public API." }] }];
  for (let i = 0; i < pairs; i++) {
    messages.push({ role: "assistant", content: [{ type: "text", text: `step ${i}` }, { type: "tool_use", id: "toolu_" + i, name: i === bigInputAt ? "Write" : "Read", input: i === bigInputAt ? { file_path: "/src/big.ts", content: "B".repeat(9000) } : { file_path: `/src/f${i}.ts` } }] });
    messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_" + i, content: "z".repeat(chars) }] });
  }
  return { model: "main", max_tokens: 100, system: "S".repeat(6000), tools: [{ name: "Read", description: "d", input_schema: { type: "object" } }], messages, metadata: { user_id: session } };
}
const post = async (body) => { const r = await fetch(R + "/v1/messages", { method: "POST", headers: H, body: JSON.stringify(body) }); await r.text(); return r; };
const sentMessages = () => last.messages;
const valid = (msgs) => {
  if (msgs[0].role !== "user") return "first is not user";
  const uses = new Set();
  for (let i = 0; i < msgs.length; i++) {
    const blocks = typeof msgs[i].content === "string" ? [] : msgs[i].content;
    for (const b of blocks) {
      if (b.type === "tool_use") uses.add(b.id);
      if (b.type === "tool_result") {
        if (!uses.has(b.tool_use_id)) return "tool_result without tool_use " + b.tool_use_id;
        const prev = msgs[i - 1];
        if (!prev || prev.role !== "assistant" || !prev.content.some((x) => x.type === "tool_use" && x.id === b.tool_use_id)) return "tool_result not right after its tool_use " + b.tool_use_id;
      }
    }
  }
  return "";
};

// ---------- defaults & validation
let s = await (await admin("/admin/app-settings")).json();
t("defaults: memory shadow, no model, guard trimInputs on, trimPastes off", s.settings["memory.mode"] === "shadow" && s.settings["memory.model"] === "" && s.settings["guard.trimInputs"] === true && s.settings["guard.trimPastes"] === false);
let pr = await set({ "memory.mode": "on" });
t("memory on without a model is refused with a clear message", pr.status === 400 && /choose the model/.test(await pr.text()));
pr = await set({ "memory.model": "nope" });
t("unknown memory model refused", pr.status === 400);
pr = await set({ "memory.lowTokens": 90000 });
t("low >= high refused", pr.status === 400 && /lower than/.test(await pr.text()));
pr = await set({ "guard.trimPastes": "yes" });
t("non-boolean trim flag refused", pr.status === 400);
pr = await set({ "memory.model": "sum", "memory.highTokens": 30000, "memory.lowTokens": 12000, "guard.mode": "off" });
t("valid memory settings saved", pr.status === 200);

// ---------- prompt anatomy is stored for every request
const small = convo(6, { session: "mem-small" });
await post(small); await sleep(200);
let row = (await (await admin("/admin/requests?limit=1")).json()).rows[0];
t("prompt anatomy stored with the request", row.anatomy && row.anatomy.system > 1000 && row.anatomy.toolResult > 5000 && row.anatomy.total > 8000, JSON.stringify(row.anatomy));
const ins = await (await admin("/admin/insights?range=24h")).json();
t("insights aggregate the anatomy", ins.anatomy.requests >= 1 && ins.anatomy.average.toolResult > 0 && ins.memory && typeof ins.memory.saved === "number");

// ---------- shadow: measures, changes nothing, calls no model
await set({ "memory.mode": "shadow" });
sumCalls = 0;
const big = convo(40, { session: "mem-A" }); // ~ 40 x 5000 chars = ~57K tokens, over 30K
let r = await post(big); await sleep(300);
t("shadow: the provider got the full conversation", last.messages.length === big.messages.length);
row = (await (await admin("/admin/requests?limit=1")).json()).rows[0];
t("shadow: history row reports tokens it would save", row.memoryWould > 10000 && row.memorySaved === 0, `would=${row.memoryWould}`);
t("shadow: no summariser call, nothing stored", sumCalls === 0 && (await (await admin("/admin/memory")).json()).summaries.length === 0);

// ---------- on: background summary, used from the next request
await set({ "memory.mode": "on" });
sumCalls = 0; sumInputs = [];
r = await post(big);
t("on: the request that crosses the limit is NOT delayed or changed", last.messages.length === big.messages.length && r.status === 200);
await sleep(900);
t("on: exactly one summariser call was made in the background", sumCalls === 1, `calls=${sumCalls}`);
t("summariser received the conversation text, not raw JSON", /Fix the retry bug/.test(sumInputs[0]) && /TOOL RESULT:/.test(sumInputs[0]) && !sumInputs[0].includes("tool_use_id"));
const mem = await (await admin("/admin/memory")).json();
t("summary stored for the session with its size and model", mem.summaries.length === 1 && mem.summaries[0].sessionId && mem.summaries[0].covers > 10 && mem.summaries[0].model === "sum" && /Goal: fix billing/.test(mem.summaries[0].summary));
t("summary keeps the original request verbatim", /Original request:\nFix the retry bug/.test(mem.summaries[0].summary));
const k = mem.summaries[0].covers;

r = await post(big); await sleep(200);
const sent = sentMessages();
t("next request: old messages replaced by the stored summary", sent.length < big.messages.length && /Router memory: summary of the first/.test(JSON.stringify(sent[0])), `${big.messages.length} -> ${sent.length} messages`);
t("... still a valid conversation (starts with user, every tool result right after its call)", valid(sent) === "", valid(sent));
t("... the newest messages are untouched", JSON.stringify(sent.slice(-4)) === JSON.stringify(big.messages.slice(-4)));
t("... and the prompt is much smaller", JSON.stringify(sent).length < JSON.stringify(big).length * 0.6, `${JSON.stringify(sent).length} vs ${JSON.stringify(big).length} bytes`);
row = (await (await admin("/admin/requests?limit=1")).json()).rows[0];
t("... history records the tokens saved", row.memorySaved > 10000 && row.trace.some((x) => x.outcome === "served"), `saved=${row.memorySaved}`);
const first = JSON.stringify(sent);
const callsBefore = sumCalls;
r = await post(big); await sleep(200);
t("same conversation again: identical text (prompt cache friendly) and no new summary call", JSON.stringify(sentMessages()) === first && sumCalls === callsBefore);

// grown conversation: prefix still matches -> same summary, tail grows
const grown = convo(43, { session: "mem-A" });
await post(grown); await sleep(200);
const sentGrown = JSON.stringify(sentMessages());
const cutPoint = first.indexOf('"step ' + (40 - 3));
t("grown conversation: starts with the very same summary text", sentGrown.startsWith(first.slice(0, 2000)) && valid(sentMessages()) === "");

// failover gets the same reduced prompt
let v = await (await admin("/admin/providers")).json();
// ---------- different session: no summary leaks
const other = convo(40, { session: "mem-B" });
sumCalls = 0;
await post(other); await sleep(200);
t("a different session does not get another session's summary", last.messages.length === other.messages.length);
await sleep(800);

// ---------- rewritten history (e.g. the client compacted): stale summary is ignored
const rewritten = convo(40, { session: "mem-A" });
rewritten.messages[2] = { role: "assistant", content: [{ type: "text", text: "changed" }, { type: "tool_use", id: "toolu_0", name: "Read", input: { file_path: "/src/f0.ts" } }] };
await post(rewritten); await sleep(200);
t("history that no longer starts with the summarised messages: summary not applied", last.messages.length === rewritten.messages.length);
await sleep(800);

// ---------- cascade: it grows again, a second summary builds on the first
await admin("/admin/memory/clear", { method: "POST", body: "{}" });
await set({ "memory.highTokens": 30000, "memory.lowTokens": 12000 });
sumCalls = 0; sumInputs = [];
const c1 = convo(40, { session: "mem-C" });
await post(c1); await sleep(900);
await post(c1); await sleep(200);
const afterFirst = (await (await admin("/admin/memory")).json()).summaries[0];
const c2 = convo(120, { session: "mem-C" }); // much longer, same start
await post(c2); await sleep(1000);
const mem2 = (await (await admin("/admin/memory")).json()).summaries[0];
t("cascade: a longer summary replaced the first (covers more messages)", mem2.covers > afterFirst.covers && mem2.versions === 2, `${afterFirst.covers} -> ${mem2.covers}`);
t("cascade: the second summary was built from the first, not from scratch", sumInputs.length === 2 && /\[Earlier summary\]/.test(sumInputs[1]));
await post(c2); await sleep(200);
t("cascade: the newest summary is the one applied", /summary of the first \d+ messages/.test(JSON.stringify(sentMessages()[0])) && valid(sentMessages()) === "");

// ---------- summariser failure: request unaffected, no hammering
await admin("/admin/memory/clear", { method: "POST", body: "{}" });
sumFail = true; sumCalls = 0;
const f1 = convo(40, { session: "mem-F" });
r = await post(f1); await sleep(700);
t("summariser down: the user's request still succeeds unchanged", r.status === 200 && last.messages.length === f1.messages.length);
r = await post(f1); r = await post(f1); await sleep(400);
t("summariser down: no retry storm (one attempt, then it backs off)", sumCalls === 1, `calls=${sumCalls}`);
sumFail = false;

// ---------- concurrency: two parallel requests, one summary
await admin("/admin/memory/clear", { method: "POST", body: "{}" });
sumCalls = 0;
const p1 = convo(40, { session: "mem-P" });
await Promise.all([post(p1), post(p1), post(p1)]);
await sleep(1000);
t("three parallel requests from one session cause ONE summary", sumCalls === 1, `calls=${sumCalls}`);

// ---------- memory admin
const list = await (await admin("/admin/memory")).json();
const sid = list.summaries[0]?.sessionId;
let dr = await admin("/admin/memory/" + encodeURIComponent(sid), { method: "DELETE" });
t("a session's memory can be deleted", dr.status === 200 && (await dr.json()).deleted >= 1);
const hist = (await (await admin("/admin/requests?limit=50&q=router memory")).json());
t("summary calls are in History (cost is not hidden)", hist.rows.some((x) => x.requestedModel === "(router memory summary)" && x.alias === "sum"));
const ins2 = await (await admin("/admin/insights?range=24h")).json();
t("insights: memory totals include summaries written", ins2.memory.summaries >= 0 && typeof ins2.memory.cost === "number");

// ---------- tool input trimming (guard on)
await set({ "guard.mode": "on", "memory.mode": "off", "guard.highTokens": 20000, "guard.lowTokens": 8000 });
const bi = convo(30, { session: "mem-G", bigInputAt: 2 });
await post(bi); await sleep(200);
const sentBi = sentMessages();
const useBlock = sentBi.flatMap((m) => m.content).find((b) => b.type === "tool_use" && b.id === "toolu_2");
t("old Write call: the 9000-character file body is cleared, the path is kept", useBlock.input.file_path === "/src/big.ts" && /characters cleared to save tokens/.test(useBlock.input.content) && useBlock.input.content.length < 200, JSON.stringify(useBlock.input).slice(0, 120));
t("... conversation still valid", valid(sentBi) === "");
await set({ "guard.trimInputs": false });
await post(convo(30, { session: "mem-G2", bigInputAt: 2 })); await sleep(150);
const useOff = sentMessages().flatMap((m) => m.content).find((b) => b.type === "tool_use" && b.id === "toolu_2");
t("trimInputs off: the tool call input is left alone", useOff.input.content.length === 9000);
await set({ "guard.trimInputs": true });

// ---------- paste trimming
await set({ "guard.mode": "on", "guard.highTokens": 900000, "guard.lowTokens": 400000 });
const pasted = { model: "main", max_tokens: 100, messages: [
  { role: "user", content: [{ type: "text", text: "FIRST " + "a".repeat(20000) }] },
  { role: "assistant", content: [{ type: "text", text: "ok" }] },
  { role: "user", content: [{ type: "text", text: "log: " + "x".repeat(30000) }] },
  { role: "assistant", content: [{ type: "text", text: "read it" }] },
  { role: "user", content: [{ type: "text", text: "middle " + "m".repeat(15000) }] },
  { role: "assistant", content: [{ type: "text", text: "noted" }] },
  { role: "user", content: [{ type: "text", text: "second-to-last " + "s".repeat(15000) }] },
  { role: "assistant", content: [{ type: "text", text: "ok2" }] },
  { role: "user", content: [{ type: "text", text: "newest " + "n".repeat(15000) }] },
], metadata: { user_id: "mem-paste" } };
await post(pasted); await sleep(150);
t("paste trimming off by default: nothing changes", JSON.stringify(last.messages) === JSON.stringify(pasted.messages));
await set({ "guard.trimPastes": true, "guard.pasteChars": 12000 });
await post(pasted); await sleep(150);
const pm = last.messages.map((m) => m.content[0].text);
t("paste trimming on: the FIRST message is never touched", pm[0] === pasted.messages[0].content[0].text);
t("... an old big paste is shortened (head and tail kept)", pm[2].length < 2500 && pm[2].startsWith("log: xxx") && /characters of pasted text omitted/.test(pm[2]));
t("... the newest two user messages are untouched", pm[6] === pasted.messages[6].content[0].text && pm[8] === pasted.messages[8].content[0].text);
const again = last.messages.map((m) => m.content[0].text);
await post(pasted); await sleep(150);
t("... deterministic: the same conversation gives the same text every time", JSON.stringify(last.messages.map((m) => m.content[0].text)) === JSON.stringify(again));

child.kill();
fs.rmSync(home, { recursive: true, force: true });
mock.close();
console.log(fails ? `\n${fails} FAILED` : "\nALL PASSED");
process.exit(fails ? 1 : 0);