# 11 — Backend: router memory (rolling summary), prompt anatomy, smaller old tool calls and pastes

**Run after 09 and 10.** Node server only. Then run `12-web-memory-anatomy.md`.

## The idea, in plain words

Claude Code sends the whole conversation on every request because the model has no memory. The router now **remembers for it** and sends less, in four safe steps. Each step is measured, none of them can make a request fail, and every saving is recorded per request.

1. **Prompt anatomy (measure first).** Every request stores an estimate of what its prompt was made of: system prompt, tool definitions, your messages, AI text, thinking, tool calls, tool results, images (`src/anatomy.ts`, column `requests.anatomy`). `GET /admin/insights` returns the average over recent requests. You cannot shrink what you cannot see: this shows which part to attack.
2. **Old tool calls get smaller** (`guard.trimInputs`, default on). When the context guard clears an old tool OUTPUT, the big strings inside the matching tool CALL (for example the whole file body of an old `Write`) are replaced by a one-line note. The call still has its tool name, file path and other fields, so the conversation stays valid. It uses the same per-session memory as the guard, so the text is identical on every request.
3. **Old pasted text gets smaller** (`guard.trimPastes`, default **off**, it edits what the user wrote). User text blocks over `guard.pasteChars` (default 12,000 characters) keep their first 1,500 and last 500 characters, only in OLD messages: the first user message and the newest two user text messages are never touched. It is a pure function of the text and the message's age, so it is stable and cache friendly.
4. **Router memory** (`src/memory.ts`, table `memory_summaries`, settings `memory.*`). When the prompt passes `memory.highTokens` (default 80,000), a cheap model chosen in `memory.model` writes a summary of the OLD messages **in the background**. The summary is stored with a SHA-1 fingerprint of the exact messages it covers. On every later request whose first N messages still match that fingerprint, those N messages are replaced by the stored summary (the user's original request is kept word for word inside it). The text never changes between requests, so the provider's prompt cache keeps hitting. Rules that keep it safe:
   - the request that crosses the limit is not delayed and not changed; the summary is used from the next request;
   - the cut falls only at an assistant message or at a user message without tool results, the newest 4 messages are never summarised, so the result always starts with a user message and every tool result stays right after its tool call;
   - a longer conversation gets a second summary built from the first plus the new messages (cascade);
   - if the conversation start changes (for example the client compacted itself) the stale summary is ignored;
   - if the summary model fails, the request goes out unchanged and there is no retry for 5 minutes; three parallel requests cause one summary;
   - `memory.mode`: `off`, `shadow` (default: no model call, records what it would save), `on` (needs `memory.model`, enforced by the settings API);
   - each summary call is a normal row in History (`requested_model` = "(router memory summary)") with its real tokens and cost.
   The summary is lossy by nature, so start in shadow mode.

Honest limits: token counts are estimates (about 3.5 characters per token); a summary can drop small details; it works inside one conversation only (after `/clear` a new conversation starts empty). A request that is mostly system prompt and tool definitions cannot be shrunk by any of this.

## How to work (read this first)

- This file is **complete**. Do not open, search or read any other file or folder. For a diff, open only that one file.
- Apply each diff from the repo root with `git apply --ignore-whitespace --whitespace=nowarn <file.patch>` (save the block to a `.patch` file first) or edit by hand: `-` lines removed, `+` lines added, the rest is context. If a hunk already looks like the `+` version, skip it and say so.
- Existing files use Windows line endings (CRLF); keep them. No refactors, no renames, no formatting changes.
- Do **not** touch the user's VS Code settings or `~/.claude/settings.json`. Never print, log or commit `.env` values.
- Finish by running the verification commands and paste their **real output**.

## Steps

### Step 1 — Create these new files

### `src/anatomy.ts` — NEW file

````ts
/**
 * "Where do my prompt tokens go?" Splits the prompt Claude Code sent into the parts that make it up.
 * Numbers are estimates (about 3.5 characters per token); images count as a fixed cost.
 */
export interface Anatomy {
  system: number;
  tools: number;
  userText: number;
  assistantText: number;
  thinking: number;
  toolUse: number;
  toolResult: number;
  images: number;
  total: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
const CPT = 3.5;
const IMAGE_TOKENS = 1700;

const len = (v: unknown): number => {
  if (v == null) return 0;
  if (typeof v === "string") return v.length;
  try { return JSON.stringify(v).length; } catch { return 0; }
};

function textLen(c: Json): { chars: number; images: number } {
  if (typeof c === "string") return { chars: c.length, images: 0 };
  let chars = 0, images = 0;
  if (Array.isArray(c)) {
    for (const p of c) {
      if (p?.type === "text") chars += String(p.text ?? "").length;
      else if (p?.type === "image") images++;
      else chars += len(p);
    }
  }
  return { chars, images };
}

export function promptAnatomy(body: Json): Anatomy {
  const a = { system: 0, tools: 0, userText: 0, assistantText: 0, thinking: 0, toolUse: 0, toolResult: 0, images: 0 };
  try {
    a.system = len(body?.system) / CPT;
    a.tools = len(body?.tools) / CPT;
    const msgs: Json[] = Array.isArray(body?.messages) ? body.messages : [];
    let imgs = 0;
    for (const m of msgs) {
      const blocks: Json[] = typeof m?.content === "string" ? [{ type: "text", text: m.content }] : Array.isArray(m?.content) ? m.content : [];
      for (const b of blocks) {
        switch (b?.type) {
          case "text": (m.role === "assistant" ? (a.assistantText += String(b.text ?? "").length / CPT) : (a.userText += String(b.text ?? "").length / CPT)); break;
          case "thinking": case "redacted_thinking": a.thinking += len(b.thinking ?? b.data) / CPT; break;
          case "tool_use": a.toolUse += len(b.input) / CPT + 12; break;
          case "tool_result": { const t = textLen(b.content); a.toolResult += t.chars / CPT; imgs += t.images; break; }
          case "image": imgs++; break;
          default: a.userText += len(b) / CPT;
        }
      }
    }
    a.images = imgs * IMAGE_TOKENS;
  } catch { /* estimates only */ }
  const r = (n: number) => Math.round(n);
  const out = {
    system: r(a.system), tools: r(a.tools), userText: r(a.userText), assistantText: r(a.assistantText),
    thinking: r(a.thinking), toolUse: r(a.toolUse), toolResult: r(a.toolResult), images: r(a.images),
  };
  return { ...out, total: Object.values(out).reduce((x, y) => x + y, 0) };
}
````

### `src/memory.ts` — NEW file

````ts
import crypto from "node:crypto";
import type { IncomingMessage } from "node:http";
import { estimateTokens } from "./contextGuard";
import { getCfg } from "./config";
import { costOf } from "./pricing";
import { db, getSetting } from "./db";
import * as history from "./history";
import { buildBody, buildHeaders, keyOrder } from "./routing";
import type { InFlight, RecentEntry } from "./live";
import * as live from "./live";

/**
 * Router memory = a rolling summary of the OLD part of a conversation.
 *
 * Claude Code re-sends everything on every request and the model keeps no memory. So the router
 * remembers for it: when the prompt grows past `highTokens`, a cheap model (memory.model) writes a
 * summary of the old messages in the background. The summary is stored in SQLite together with a
 * fingerprint of the messages it covers. From then on, every request that still starts with those same
 * messages gets the stored summary instead of them. The text is identical on every request, so the
 * provider's prompt cache keeps working. Nothing blocks the user: the request that crosses the limit goes
 * out as it is, and the summary is used from the next one.
 *
 * Modes: off | shadow (measure what it would save, no model call, nothing changes) | on.
 */
export type MemoryMode = "off" | "shadow" | "on";

export interface MemoryConfig {
  mode: MemoryMode;
  model: string;
  highTokens: number;
  lowTokens: number;
}

export interface MemoryResult {
  mode: MemoryMode;
  /** Tokens removed from this request by an applied summary. */
  saved: number;
  /** Shadow mode: tokens a summary would remove. */
  would: number;
  /** Messages replaced by the summary (0 = none). */
  covers: number;
  /** A summary is being written in the background right now. */
  pending: boolean;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

export function readMemoryConfig(): MemoryConfig {
  return {
    mode: getSetting("memory.mode") as MemoryMode,
    model: String(getSetting("memory.model") ?? ""),
    highTokens: Number(getSetting("memory.highTokens")),
    lowTokens: Number(getSetting("memory.lowTokens")),
  };
}

const CPT = 3.5;
const SUMMARY_BUDGET = 1800; // tokens reserved for the summary itself
const KEEP_MESSAGES = 4; // the newest messages are never summarised
const MIN_GAIN = 4000; // not worth a summary below this
const RETRY_AFTER_FAIL_MS = 5 * 60_000;
const TRANSCRIPT_CAP_CHARS = 200_000;

const hash = (messages: Json[], k: number): string =>
  crypto.createHash("sha1").update(JSON.stringify(messages.slice(0, k))).digest("hex");

const msgTokens = (m: Json): number => {
  let images = 0;
  const t = JSON.stringify(m, (key, v) => {
    if (key === "data" && typeof v === "string" && v.length > 2000) { images++; return ""; }
    return v;
  });
  return Math.ceil(t.length / CPT) + images * 1700;
};

const blocksOf = (m: Json): Json[] =>
  typeof m?.content === "string" ? [{ type: "text", text: m.content }] : Array.isArray(m?.content) ? m.content : [];

const hasToolResult = (m: Json): boolean => blocksOf(m).some((b) => b?.type === "tool_result");

const firstUserText = (messages: Json[]): string =>
  blocksOf(messages[0]).filter((b) => b?.type === "text").map((b) => String(b.text ?? "")).join("\n").slice(0, 3000);

export const summaryBlock = (covers: number, original: string, summary: string): string =>
  `[Router memory: summary of the first ${covers} messages of this same conversation, written by the router to save tokens. Treat it as reliable context from earlier in this session.]\n\nOriginal request:\n${original}\n\nSummary of the work so far:\n${summary}`;

/** Replace the first `k` messages by the summary. Result still starts with a user message and keeps every tool call next to its result. */
export function withSummary(messages: Json[], k: number, text: string): Json[] {
  const tail = messages.slice(k);
  const first = tail[0];
  if (first?.role === "user") {
    return [{ ...first, content: [{ type: "text", text }, ...blocksOf(first)] }, ...tail.slice(1)];
  }
  return [{ role: "user", content: [{ type: "text", text }] }, ...tail];
}

/** Where may a cut fall? At an assistant message, or at a user message that starts a new request (no tool result). */
const isBoundary = (messages: Json[], i: number): boolean =>
  i > 0 && i < messages.length && (messages[i].role === "assistant" || (messages[i].role === "user" && !hasToolResult(messages[i])));

function chooseCut(messages: Json[], fixedTokens: number, lowTokens: number, after: number): number | null {
  const n = messages.length;
  const suffix = new Array<number>(n + 1).fill(0);
  for (let i = n - 1; i >= 0; i--) suffix[i] = suffix[i + 1] + msgTokens(messages[i]);
  const last = n - KEEP_MESSAGES;
  let best: number | null = null;
  for (let i = Math.max(2, after + 1); i <= last; i++) {
    if (!isBoundary(messages, i)) continue;
    best = i; // the latest allowed boundary is the fallback
    if (fixedTokens + SUMMARY_BUDGET + suffix[i] <= lowTokens) return i; // earliest cut that reaches the target
  }
  return best;
}

// ---------- storage ----------
interface Row {
  id: number; session_id: string; upto_count: number; prefix_hash: string; summary: string;
  summary_tokens: number; source_tokens: number; model: string; cost: number; created_at: number;
}
const rowsFor = db.prepare("SELECT * FROM memory_summaries WHERE session_id = ? ORDER BY upto_count DESC");
const insertRow = db.prepare(
  "INSERT OR REPLACE INTO memory_summaries(session_id, upto_count, prefix_hash, summary, summary_tokens, source_tokens, model, cost, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
);

export function pruneMemory(days = 14): void {
  db.prepare("DELETE FROM memory_summaries WHERE created_at < ?").run(Date.now() - days * 86400_000);
}

export function listMemory(limit = 50) {
  const rows = db.prepare(
    `SELECT m.* FROM memory_summaries m
       WHERE m.upto_count = (SELECT MAX(upto_count) FROM memory_summaries x WHERE x.session_id = m.session_id)
       ORDER BY m.created_at DESC LIMIT ?`,
  ).all(limit) as unknown as Row[];
  return rows.map((r) => ({
    sessionId: r.session_id, covers: r.upto_count, summaryTokens: r.summary_tokens, sourceTokens: r.source_tokens,
    model: r.model, cost: r.cost, createdAt: r.created_at, summary: r.summary,
    versions: (db.prepare("SELECT COUNT(*) AS n FROM memory_summaries WHERE session_id = ?").get(r.session_id) as { n: number }).n,
  }));
}

export function deleteMemory(sessionId: string): number {
  pendingJobs.delete(sessionId);
  return Number(db.prepare("DELETE FROM memory_summaries WHERE session_id = ?").run(sessionId).changes);
}
export function clearMemory(): number {
  pendingJobs.clear();
  return Number(db.prepare("DELETE FROM memory_summaries").run().changes);
}

// ---------- summariser ----------
const fakeReq = { headers: {} } as unknown as IncomingMessage;
const pendingJobs = new Map<string, Promise<void>>();
const failUntil = new Map<string, number>();

function transcript(messages: Json[], from: number, to: number, previous: string | null): string {
  const render = (resultCap: number): string => {
    const out: string[] = [];
    if (previous) out.push(`[Earlier summary]\n${previous}\n`);
    for (let i = from; i < to; i++) {
      const m = messages[i];
      for (const b of blocksOf(m)) {
        if (b?.type === "text") out.push(`${m.role === "user" ? "USER" : "ASSISTANT"}: ${String(b.text ?? "")}`);
        else if (b?.type === "tool_use") out.push(`ASSISTANT called ${b.name}: ${JSON.stringify(b.input ?? {}).slice(0, 300)}`);
        else if (b?.type === "tool_result") {
          const c = typeof b.content === "string" ? b.content : Array.isArray(b.content) ? b.content.map((p: Json) => (p?.type === "text" ? p.text : "[image]")).join("\n") : "";
          out.push(`TOOL RESULT: ${c.slice(0, resultCap)}${c.length > resultCap ? ` ...[${c.length - resultCap} more characters]` : ""}`);
        } else if (b?.type === "image") out.push("[image]");
      }
    }
    return out.join("\n");
  };
  for (const cap of [600, 250, 100]) {
    const t = render(cap);
    if (t.length <= TRANSCRIPT_CAP_CHARS) return t;
  }
  const t = render(100);
  return `${t.slice(0, TRANSCRIPT_CAP_CHARS * 0.25)}\n...[middle omitted]...\n${t.slice(-TRANSCRIPT_CAP_CHARS * 0.75)}`;
}

const SYSTEM = [
  "You write a memory note for a coding assistant that will continue this same conversation without seeing the old messages.",
  "Write plain text, at most about 1200 words, in these sections: Goal and requirements; Decisions made; Files and commands touched, with their current state;",
  "Errors hit and how they were fixed; Open tasks and next steps; Facts worth keeping (paths, names, versions, settings).",
  "Be specific and literal: keep exact file paths, identifiers and numbers. Do not invent anything. Do not address the user.",
].join(" ");

async function callSummariser(alias: string, prompt: string): Promise<{ text: string; u: { in: number; out: number; cacheRead: number; cacheWrite: number }; provider: string; model: string; key: string; ms: number; cost: number }> {
  const c = getCfg();
  const m = c.models[alias];
  const p = m && c.providers[m.provider];
  if (!m || !p || p.disabled) throw new Error(`memory model "${alias}" is not usable`);
  const key = keyOrder(p, m, "memory").find((k) => live.cooldownLeft(k) === 0);
  if (!key) throw new Error(`no usable key for memory model "${alias}"`);
  const started = Date.now();
  const body = buildBody({ model: alias, max_tokens: 2000, system: SYSTEM, messages: [{ role: "user", content: prompt }], stream: false }, m, p);
  const res = await fetch(`${p.baseURL}/v1/messages`, {
    method: "POST", headers: buildHeaders(fakeReq, p, key), body, signal: AbortSignal.timeout(90_000),
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${m.provider}: ${raw.slice(0, 120).replace(/[A-Za-z0-9_-]{28,}/g, "[redacted]")}`);
  const j = JSON.parse(raw);
  const text = (Array.isArray(j.content) ? j.content : []).filter((b: Json) => b?.type === "text").map((b: Json) => String(b.text ?? "")).join("\n").trim();
  if (text.length < 40) throw new Error("the memory model returned no usable summary");
  const us = j.usage ?? {};
  const u = { in: Number(us.input_tokens) || 0, out: Number(us.output_tokens) || 0, cacheRead: Number(us.cache_read_input_tokens) || 0, cacheWrite: Number(us.cache_creation_input_tokens) || 0 };
  return { text, u, provider: m.provider, model: m.model, key, ms: Date.now() - started, cost: costOf(m.price, u) };
}

function logCall(alias: string, sessionId: string, r: Awaited<ReturnType<typeof callSummariser>>): void {
  const now = Date.now();
  const entry: RecentEntry = {
    ts: now, alias, provider: r.provider, model: r.model, key: r.key, status: 200, ms: r.ms,
    ...r.u, cost: r.cost, sessionId, startedAt: now - r.ms, durationMs: r.ms,
  };
  const f = {
    stream: false, askedAlias: alias, requestedModel: "(router memory summary)", resolvedVia: "exact",
    trace: [{ route: alias, key: r.key, outcome: "served", detail: "memory summary" }],
  } as unknown as InFlight;
  history.recordFinished(`mem-${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`, entry, f);
}

async function runJob(sessionId: string, messages: Json[], k: number, previous: Row | null, cfg: MemoryConfig): Promise<void> {
  try {
    const from = previous ? previous.upto_count : 0;
    const source = transcript(messages, from, k, previous ? previous.summary : null);
    const r = await callSummariser(cfg.model, `Conversation so far:\n\n${source}\n\nWrite the memory note now.`);
    const text = summaryBlock(k, firstUserText(messages), r.text);
    insertRow.run(sessionId, k, hash(messages, k), text, Math.ceil(text.length / CPT), Math.ceil(source.length / CPT), cfg.model, r.cost, Date.now());
    logCall(cfg.model, sessionId, r);
    console.log(`[MEMORY] ${sessionId}: summarised ${k} messages (~${Math.ceil(source.length / CPT)} -> ~${Math.ceil(text.length / CPT)} tokens) with ${cfg.model}`);
  } catch (e) {
    failUntil.set(sessionId, Date.now() + RETRY_AFTER_FAIL_MS);
    console.warn(`[MEMORY] ${sessionId}: summary failed, retrying in 5 min: ${(e as Error).message}`);
  }
}

/** Test/debug helper: wait for the background summary of a session to finish. */
export async function memoryIdle(sessionId: string): Promise<void> {
  await pendingJobs.get(sessionId);
}

/**
 * `original` is the body exactly as the client sent it (used to recognise the conversation);
 * `current` is the body after the context guard (the one the summary is applied to). Never throws.
 */
export function applyMemory(original: Json, current: Json, sessionId: string, cfg: MemoryConfig = readMemoryConfig()): { body: Json; result: MemoryResult } {
  const none = (extra: Partial<MemoryResult> = {}): { body: Json; result: MemoryResult } => ({
    body: current, result: { mode: cfg.mode, saved: 0, would: 0, covers: 0, pending: pendingJobs.has(sessionId), ...extra },
  });
  try {
    if (cfg.mode === "off" || !Array.isArray(original?.messages) || !Array.isArray(current?.messages)) return none();
    const orig: Json[] = original.messages;
    if (orig.length < KEEP_MESSAGES + 3 || orig.length !== current.messages.length) return none();

    // 1) a stored summary whose covered messages are still exactly the start of this conversation
    let body = current;
    let active: Row | null = null;
    let saved = 0;
    if (cfg.mode === "on") {
      for (const r of rowsFor.all(sessionId) as unknown as Row[]) {
        if (orig.length > r.upto_count && hash(orig, r.upto_count) === r.prefix_hash) { active = r; break; }
      }
      if (active) {
        const before = estimateTokens(current);
        body = { ...current, messages: withSummary(current.messages, active.upto_count, active.summary) };
        saved = Math.max(0, before - estimateTokens(body));
      }
    }

    // 2) still too big: write a (longer-reaching) summary in the background, or measure it in shadow mode
    const est = estimateTokens(body);
    const covers = active?.upto_count ?? 0;
    if (est <= cfg.highTokens) return { body, result: { mode: cfg.mode, saved, would: 0, covers, pending: pendingJobs.has(sessionId) } };

    const fixed = estimateTokens({ ...original, messages: [] });
    const cut = chooseCut(orig, fixed, cfg.lowTokens, covers);
    if (cut === null) return { body, result: { mode: cfg.mode, saved, would: 0, covers, pending: pendingJobs.has(sessionId) } };

    if (cfg.mode === "shadow") {
      const after = estimateTokens({ ...current, messages: withSummary(current.messages, cut, "x".repeat(Math.round(SUMMARY_BUDGET * CPT))) });
      const would = Math.max(0, estimateTokens(current) - after);
      return { body, result: { mode: "shadow", saved: 0, would: would >= MIN_GAIN ? would : 0, covers: 0, pending: false } };
    }

    const gain = est - estimateTokens({ ...body, messages: withSummary(body.messages, cut, "x".repeat(Math.round(SUMMARY_BUDGET * CPT))) });
    if (gain >= MIN_GAIN && cfg.model && !pendingJobs.has(sessionId) && Date.now() >= (failUntil.get(sessionId) ?? 0)) {
      const snapshot = orig.slice();
      const job = runJob(sessionId, snapshot, cut, active, cfg).finally(() => pendingJobs.delete(sessionId));
      pendingJobs.set(sessionId, job);
    }
    return { body, result: { mode: "on", saved, would: 0, covers, pending: pendingJobs.has(sessionId) } };
  } catch (e) {
    console.warn("[MEMORY] skipped:", (e as Error).message);
    return none();
  }
}
````

### `scripts/memory-smoke.mjs` — NEW file

````js
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
````

### Step 2 — Apply these diffs

### `src/db.ts` — migration 5 (memory_summaries, memory and anatomy columns) + new settings defaults

````diff
--- a/src/db.ts
+++ b/src/db.ts
@@ -90,6 +90,24 @@
    ALTER TABLE requests ADD COLUMN trace TEXT;`,
   // 4: fast "today" counters per provider (daily request/token limits)
   `CREATE INDEX idx_requests_provider_ended ON requests(provider, ended_at);`,
+  // 5: router memory (rolling summaries) + prompt anatomy per request
+  `CREATE TABLE memory_summaries (
+     id INTEGER PRIMARY KEY AUTOINCREMENT,
+     session_id TEXT NOT NULL,
+     upto_count INTEGER NOT NULL,
+     prefix_hash TEXT NOT NULL,
+     summary TEXT NOT NULL,
+     summary_tokens INTEGER NOT NULL,
+     source_tokens INTEGER NOT NULL,
+     model TEXT NOT NULL,
+     cost REAL NOT NULL DEFAULT 0,
+     created_at INTEGER NOT NULL,
+     UNIQUE (session_id, upto_count)
+   );
+   CREATE INDEX idx_memory_session ON memory_summaries(session_id, upto_count DESC);
+   ALTER TABLE requests ADD COLUMN memory_saved INTEGER NOT NULL DEFAULT 0;
+   ALTER TABLE requests ADD COLUMN memory_would INTEGER NOT NULL DEFAULT 0;
+   ALTER TABLE requests ADD COLUMN anatomy TEXT;`,
 ];
 
 function migrate(): void {
@@ -124,6 +142,13 @@
   "guard.minChars": 1200,
   "routing.failover": "auto",
   "routing.retries": 2,
+  "guard.trimInputs": true,
+  "guard.trimPastes": false,
+  "guard.pasteChars": 12_000,
+  "memory.mode": "shadow",
+  "memory.model": "",
+  "memory.highTokens": 80_000,
+  "memory.lowTokens": 35_000,
 } as const;
 export type SettingKey = keyof typeof SETTING_DEFAULTS;
 
````

### `src/contextGuard.ts` — trim old tool-call inputs, stateless paste trimming, new config fields

````diff
--- a/src/contextGuard.ts
+++ b/src/contextGuard.ts
@@ -22,6 +22,11 @@
   lowTokens: number;
   keepRecent: number;
   minChars: number;
+  /** Also shrink the big text inside the tool CALL (e.g. the file body of an old Write) when its result is cleared. */
+  trimInputs: boolean;
+  /** Shrink very large pasted text in OLD user messages (never the first message, never the newest two). */
+  trimPastes: boolean;
+  pasteChars: number;
 }
 
 export interface GuardResult {
@@ -43,6 +48,9 @@
     lowTokens: Number(getSetting("guard.lowTokens")),
     keepRecent: Number(getSetting("guard.keepRecent")),
     minChars: Number(getSetting("guard.minChars")),
+    trimInputs: (getSetting("guard.trimInputs") as boolean) !== false,
+    trimPastes: (getSetting("guard.trimPastes") as boolean) === true,
+    pasteChars: Number(getSetting("guard.pasteChars")),
   };
 }
 
@@ -60,6 +68,64 @@
 // eslint-disable-next-line @typescript-eslint/no-explicit-any
 type Json = any;
 
+// ---- old tool-call inputs and old pasted text (stateless, deterministic) ----
+const INPUT_DEPTH = 4;
+
+/** Characters held by big strings inside a tool call's input. */
+function bigChars(v: Json, min: number, depth = 0): number {
+  if (typeof v === "string") return v.length >= min ? v.length : 0;
+  if (depth >= INPUT_DEPTH || v == null || typeof v !== "object") return 0;
+  let n = 0;
+  for (const x of Object.values(v)) n += bigChars(x, min, depth + 1);
+  return n;
+}
+
+export const inputStub = (chars: number): string => `[router: ${chars} characters cleared to save tokens]`;
+
+/** Same shape, big strings replaced: the model still sees which tool was called on which file. */
+function trimStrings(v: Json, min: number, depth = 0): Json {
+  if (typeof v === "string") return v.length >= min ? inputStub(v.length) : v;
+  if (depth >= INPUT_DEPTH || v == null || typeof v !== "object") return v;
+  if (Array.isArray(v)) return v.map((x) => trimStrings(x, min, depth + 1));
+  const out: Json = {};
+  for (const [k, x] of Object.entries(v)) out[k] = trimStrings(x, min, depth + 1);
+  return out;
+}
+
+export const pasteStub = (head: string, tail: string, omitted: number): string =>
+  `${head}\n[router: about ${omitted} characters of pasted text omitted to save tokens]\n${tail}`;
+
+interface PasteEdit {
+  mi: number;
+  bi: number;
+  text: string;
+  gain: number;
+}
+
+/** Old user text blocks above `pasteChars`, except the first user message and the newest two text turns. */
+function pasteEdits(messages: Json[], cfg: GuardConfig): PasteEdit[] {
+  if (!cfg.trimPastes) return [];
+  const turns: number[] = [];
+  messages.forEach((m, i) => {
+    if (m?.role !== "user") return;
+    const blocks: Json[] = typeof m.content === "string" ? [{ type: "text", text: m.content }] : Array.isArray(m.content) ? m.content : [];
+    if (blocks.some((b) => b?.type === "text" && String(b.text ?? "").length > 0)) turns.push(i);
+  });
+  const old = new Set(turns.slice(1, Math.max(1, turns.length - 2)));
+  const edits: PasteEdit[] = [];
+  for (const mi of old) {
+    const m = messages[mi];
+    if (!Array.isArray(m.content)) continue; // plain-string content is left alone
+    m.content.forEach((b: Json, bi: number) => {
+      if (b?.type !== "text" || typeof b.text !== "string" || b.text.length < cfg.pasteChars) return;
+      const head = b.text.slice(0, 1500), tail = b.text.slice(-500);
+      const text = pasteStub(head, tail, b.text.length - head.length - tail.length);
+      edits.push({ mi, bi, text, gain: Math.max(0, Math.ceil((b.text.length - text.length) / CHARS_PER_TOKEN)) });
+    });
+  }
+  return edits;
+}
+
 export const stubFor = (chars: number): string =>
   `[router: output of this tool call was cleared to save tokens (${chars} characters). Run the tool again if you still need it.]`;
 
@@ -129,7 +195,8 @@
     const messages: Json[] = body.messages;
     const before = estimateTokens(body);
     const slots = collect(messages);
-    if (!slots.length) return none(before);
+    const pastes = pasteEdits(messages, cfg);
+    if (!slots.length && !pastes.length) return none(before);
 
     const protectedFrom = Math.max(0, slots.length - cfg.keepRecent);
     const isProtected = (i: number) => i >= protectedFrom;
@@ -139,7 +206,7 @@
 
     // 1) everything remembered from earlier requests is applied again, unchanged.
     const apply = new Set<number>();
-    let est = before;
+    let est = before - pastes.reduce((n, p) => n + p.gain, 0);
     slots.forEach((s, i) => {
       if (cleared.has(s.id) && !isProtected(i) && !s.hasImage) {
         apply.add(i);
@@ -160,7 +227,29 @@
         else cleared.add(s.id);
       }
     }
-    if (!apply.size) return { body, result: { ...none(before).result, clearedTotal: cleared.size } };
+    // 3) the tool CALL of every cleared result: shrink the big strings inside its input as well.
+    const uses = new Map<string, { mi: number; bi: number }>();
+    if (cfg.trimInputs) {
+      messages.forEach((m, mi) => {
+        if (m?.role !== "assistant" || !Array.isArray(m.content)) return;
+        m.content.forEach((b: Json, bi: number) => {
+          if (b?.type === "tool_use" && typeof b.id === "string") uses.set(b.id, { mi, bi });
+        });
+      });
+    }
+    const inputEdits: { mi: number; bi: number; input: Json }[] = [];
+    if (cfg.trimInputs) {
+      for (const i of apply) {
+        const u = uses.get(slots[i].id);
+        if (!u) continue;
+        const blk = messages[u.mi].content[u.bi];
+        const big = bigChars(blk.input, cfg.minChars);
+        if (big <= 0) continue;
+        est -= Math.max(0, Math.ceil(big / CHARS_PER_TOKEN) - 20);
+        inputEdits.push({ mi: u.mi, bi: u.bi, input: trimStrings(blk.input, cfg.minChars) });
+      }
+    }
+    if (!apply.size && !pastes.length) return { body, result: { ...none(before).result, clearedTotal: cleared.size } };
 
     const saved = Math.max(0, before - est);
     const result: GuardResult = {
@@ -170,18 +259,29 @@
       saved: cfg.mode === "on" ? saved : 0,
       would: cfg.mode === "shadow" ? saved : 0,
       clearedNow,
-      clearedTotal: apply.size,
+      clearedTotal: apply.size + pastes.length,
     };
     if (cfg.mode !== "on") return { body, result: { ...result, afterTokens: before } };
 
     const nextMessages = messages.slice();
     const touched = new Map<number, Json>();
+    const edit = (mi: number): Json => touched.get(mi) ?? { ...messages[mi], content: messages[mi].content.slice() };
     for (const i of apply) {
       const s = slots[i];
-      const msg = touched.get(s.mi) ?? { ...messages[s.mi], content: messages[s.mi].content.slice() };
+      const msg = edit(s.mi);
       msg.content[s.bi] = { ...msg.content[s.bi], content: stubFor(s.chars) };
       touched.set(s.mi, msg);
     }
+    for (const e of inputEdits) {
+      const msg = edit(e.mi);
+      msg.content[e.bi] = { ...msg.content[e.bi], input: e.input };
+      touched.set(e.mi, msg);
+    }
+    for (const p of pastes) {
+      const msg = edit(p.mi);
+      msg.content[p.bi] = { ...msg.content[p.bi], text: p.text };
+      touched.set(p.mi, msg);
+    }
     for (const [mi, msg] of touched) nextMessages[mi] = msg;
     return { body: { ...body, messages: nextMessages }, result };
   } catch (e) {
````

### `src/live.ts` — in-flight fields for memory and anatomy

````diff
--- a/src/live.ts
+++ b/src/live.ts
@@ -32,6 +32,10 @@
   // context guard numbers for the history row
   guardSaved?: number;
   guardWould?: number;
+  // router memory (rolling summary) numbers and what the prompt was made of
+  memorySaved?: number;
+  memoryWould?: number;
+  anatomy?: import("./anatomy").Anatomy;
   // routing visibility: what the client asked for and how the router got to the route that answered
   askedAlias?: string;
   requestedModel?: string;
````

### `src/history.ts` — store/return memory and anatomy, memory stats, anatomy totals, search by asked model

````diff
--- a/src/history.ts
+++ b/src/history.ts
@@ -8,8 +8,9 @@
 const insert = db.prepare(`INSERT OR REPLACE INTO requests
   (id, session_id, alias, provider, model, key_name, status, stream, failover, started_at, first_token_at,
    ended_at, duration_ms, ttft_ms, in_tokens, out_tokens, cache_read, cache_write, ctx_tokens, cost, tps,
-   guard_saved, guard_would, asked_alias, requested_model, resolved_via, trace)
-  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
+   guard_saved, guard_would, asked_alias, requested_model, resolved_via, trace,
+   memory_saved, memory_would, anatomy)
+  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
 
 /** Called for every finished request, including failures and aborts. Never throws. */
 export function recordFinished(id: string, e: RecentEntry, f?: InFlight): void {
@@ -23,6 +24,7 @@
       f?.guardSaved ?? 0, f?.guardWould ?? 0,
     f?.askedAlias ?? null, f?.requestedModel ?? null, f?.resolvedVia ?? null,
     f?.trace?.length ? JSON.stringify(f.trace) : null,
+    f?.memorySaved ?? 0, f?.memoryWould ?? 0, f?.anatomy ? JSON.stringify(f.anatomy) : null,
     );
   } catch (err) {
     console.warn("[HISTORY] write failed:", (err as Error).message);
@@ -38,6 +40,9 @@
   /** Alias the client's model name resolved to (what you asked for). `alias` is what answered. */
   askedAlias: string | null; requestedModel: string | null; resolvedVia: string | null;
   trace: { route: string; key?: string; outcome: string; status?: number; detail?: string }[];
+  memorySaved: number; memoryWould: number;
+  /** Estimated prompt tokens by part, as the client sent it. */
+  anatomy: Record<string, number> | null;
 }
 
 type Row = Record<string, string | number | null>;
@@ -53,6 +58,8 @@
   askedAlias: (r.asked_alias as string | null) ?? null, requestedModel: (r.requested_model as string | null) ?? null,
   resolvedVia: (r.resolved_via as string | null) ?? null,
   trace: (() => { try { return r.trace ? JSON.parse(r.trace as string) : []; } catch { return []; } })(),
+  memorySaved: (r.memory_saved as number) ?? 0, memoryWould: (r.memory_would as number) ?? 0,
+  anatomy: (() => { try { return r.anatomy ? JSON.parse(r.anatomy as string) : null; } catch { return null; } })(),
 });
 
 export interface HistoryQuery {
@@ -70,9 +77,9 @@
   if (q.provider) { where.push("provider = ?"); args.push(q.provider); }
   if (q.minCtx) { where.push("ctx_tokens >= ?"); args.push(q.minCtx); }
   if (q.q) {
-    where.push("(alias LIKE ? OR model LIKE ? OR provider LIKE ? OR id LIKE ? OR session_id LIKE ?)");
+    where.push("(alias LIKE ? OR model LIKE ? OR provider LIKE ? OR id LIKE ? OR session_id LIKE ? OR requested_model LIKE ?)");
     const like = `%${q.q.replace(/[%_]/g, "")}%`;
-    args.push(like, like, like, like, like);
+    args.push(like, like, like, like, like, like);
   }
   const base = where.length ? `WHERE ${where.join(" AND ")}` : "";
   const total = (db.prepare(`SELECT COUNT(*) AS n FROM requests ${base}`).get(...args) as { n: number }).n;
@@ -133,6 +140,8 @@
       overWarn, compactions,
     },
     guard: guardStats(sinceMs),
+    memory: memoryStats(since),
+    anatomy: anatomyTotals(since),
     topSessions: [...sessions.entries()]
       .map(([sessionId, s]) => ({ sessionId, ...s }))
       .sort((a, b) => b.ctxTotal - a.ctxTotal).slice(0, 5),
@@ -158,6 +167,36 @@
   return { requests: r.n, tokens: r.t };
 }
 
+/** Router memory over a window: tokens removed, tokens it would remove (shadow), and what the summaries cost. */
+export function memoryStats(since: number) {
+  const r = db.prepare(
+    `SELECT COALESCE(SUM(memory_saved),0) AS s, COALESCE(SUM(memory_would),0) AS w,
+            SUM(CASE WHEN memory_saved > 0 OR memory_would > 0 THEN 1 ELSE 0 END) AS n FROM requests WHERE ended_at >= ?`,
+  ).get(since) as { s: number; w: number; n: number | null };
+  const m = db.prepare(
+    `SELECT COUNT(*) AS n, COALESCE(SUM(source_tokens),0) AS src, COALESCE(SUM(summary_tokens),0) AS sum, COALESCE(SUM(cost),0) AS cost
+       FROM memory_summaries WHERE created_at >= ?`,
+  ).get(since) as { n: number; src: number; sum: number; cost: number };
+  return { requests: r.n ?? 0, saved: r.s, would: r.w, summaries: m.n, summarisedTokens: m.src, summaryTokens: m.sum, cost: m.cost };
+}
+
+/** Average tokens of each prompt part over the most recent 2000 requests in the window. */
+export function anatomyTotals(since: number) {
+  const rows = db.prepare("SELECT anatomy FROM requests WHERE ended_at >= ? AND anatomy IS NOT NULL ORDER BY ended_at DESC LIMIT 2000").all(since) as unknown as { anatomy: string }[];
+  const sum: Record<string, number> = {};
+  let n = 0;
+  for (const r of rows) {
+    try {
+      const a = JSON.parse(r.anatomy) as Record<string, number>;
+      for (const [k, v] of Object.entries(a)) sum[k] = (sum[k] ?? 0) + v;
+      n++;
+    } catch { /* skip */ }
+  }
+  const avg: Record<string, number> = {};
+  for (const [k, v] of Object.entries(sum)) avg[k] = n ? Math.round(v / n) : 0;
+  return { requests: n, average: avg };
+}
+
 // ---------- housekeeping ----------
 export function pruneOld(): number {
   const days = Number(getSetting("history.retentionDays"));
@@ -191,7 +230,7 @@
           j.startedAt ? Date.parse(j.startedAt) : ended - dur, j.firstTokenAt ? Date.parse(j.firstTokenAt) : null,
           ended, dur, j.ttftMs ?? null, j.in ?? 0, j.out ?? 0, j.cacheRead ?? 0, j.cacheWrite ?? 0,
           (j.in ?? 0) + (j.cacheRead ?? 0) + (j.cacheWrite ?? 0), j.cost ?? 0, j.outputTokensPerSec ?? null, 0, 0,
-          null, null, null, null,
+          null, null, null, null, 0, 0, null,
         );
         n++;
       } catch { /* skip malformed line */ }
````

### `src/index.ts` — apply memory after the guard, store anatomy, prune old summaries

````diff
--- a/src/index.ts
+++ b/src/index.ts
@@ -6,7 +6,9 @@
 
 import { Config, ModelCfg, PORT, ProviderCfg, ROOT, ROUTER_KEY, getCfg } from "./config";
 import { handleAdmin, hostAllowed, originAllowed } from "./admin";
+import { promptAnatomy } from "./anatomy";
 import { applyGuard, pruneGuardMemory } from "./contextGuard";
+import { applyMemory, pruneMemory } from "./memory";
 import { canWrite, handleAuthRoutes, headerKeyOk, principal, seedAdminFromEnv, userCount } from "./auth";
 import * as history from "./history";
 import * as eta from "./eta";
@@ -279,7 +281,10 @@
 
   // Context guard: clear OLD tool outputs (remembered per session) before the prompt goes upstream.
   const guard = applyGuard(body, sessionId);
-  const upstreamBody = guard.body as Record<string, unknown>;
+  // Router memory: replace the old part of a long conversation by the stored summary (written in the background).
+  const memory = applyMemory(body, guard.body, sessionId);
+  const upstreamBody = memory.body as Record<string, unknown>;
+  const anatomy = promptAnatomy(body);
   if (guard.result.saved > 0 || guard.result.clearedNow > 0) {
     console.log(`[GUARD] ${sessionId} ${guard.result.mode}: ~${guard.result.beforeTokens} -> ~${guard.result.afterTokens} tokens (cleared ${guard.result.clearedNow} new, ${guard.result.clearedTotal} total)`);
   }
@@ -310,6 +315,9 @@
     eta.begin(t);
     t.guardSaved = guard.result.saved;
     t.guardWould = guard.result.would;
+    t.memorySaved = memory.result.saved;
+    t.memoryWould = memory.result.would;
+    t.anatomy = anatomy;
     t.askedAlias = alias;
     t.requestedModel = String(body.model);
     t.resolvedVia = resolved.via;
@@ -602,7 +610,8 @@
   if (n) console.log(`[HISTORY] imported ${n} requests from logs/usage.jsonl`);
   history.pruneOld();
   pruneGuardMemory();
-  setInterval(() => { history.pruneOld(); pruneGuardMemory(); }, 6 * 3600_000).unref();
+  pruneMemory();
+  setInterval(() => { history.pruneOld(); pruneGuardMemory(); pruneMemory(); }, 6 * 3600_000).unref();
 }
 eta.seedHistory()
   .catch((e) => console.warn("[ETA] usage log unreadable -> seeding with empty history:",
````

### `src/admin.ts` — memory list/forget endpoints, validation of the new settings

````diff
--- a/src/admin.ts
+++ b/src/admin.ts
@@ -12,6 +12,7 @@
 import { DATA_DIR, DB_FILE, SETTING_DEFAULTS, allSettings, db, setSetting } from "./db";
 import { userCount } from "./auth";
 import { budgetReason } from "./capacity";
+import { clearMemory, deleteMemory, listMemory } from "./memory";
 import * as history from "./history";
 import {
   MAX_SSE_CLIENTS, RECENT_MAX, addClient, cooldownLeft, coolInfoFor, dropClient, inFlight,
@@ -1089,6 +1090,16 @@
 });
 
 // ---------- app settings (SQLite) + system information ----------
+on("GET", /^\/admin\/memory$/, (_req, res) => {
+  sendJSON(res, 200, { summaries: listMemory(), stats: history.memoryStats(Date.now() - 86400e3) });
+});
+on("POST", /^\/admin\/memory\/clear$/, (_req, res) => {
+  sendJSON(res, 200, { deleted: clearMemory() });
+});
+on("DELETE", /^\/admin\/memory\/([^/]+)$/, (_req, res, [session]) => {
+  sendJSON(res, 200, { deleted: deleteMemory(decodeURIComponent(session)) });
+});
+
 on("GET", /^\/admin\/app-settings$/, (_req, res) => sendJSON(res, 200, { settings: allSettings() }));
 
 on("PUT", /^\/admin\/app-settings$/, async (req, res) => {
@@ -1108,7 +1119,20 @@
     else if (k === "pricing.peakMultiplier") {
       const n = Number(input[k]);
       if (!Number.isFinite(n) || n < 1 || n > 10) errors.push({ field: k, message: "must be a number from 1 to 10" }); else clean[k] = n;
-    } else if (k === "routing.failover") {
+    } else if (k === "guard.trimInputs" || k === "guard.trimPastes") {
+      if (typeof input[k] !== "boolean") errors.push({ field: k, message: "must be true or false" });
+      else clean[k] = input[k];
+    } else if (k === "guard.pasteChars") int(k, 2_000, 200_000);
+    else if (k === "memory.mode") {
+      if (input[k] !== "off" && input[k] !== "shadow" && input[k] !== "on") errors.push({ field: k, message: "must be off, shadow or on" });
+      else clean[k] = input[k];
+    } else if (k === "memory.model") {
+      const v = String(input[k] ?? "");
+      if (v && !getCfg().models[v]) errors.push({ field: k, message: `"${v}" is not a known model` });
+      else clean[k] = v;
+    } else if (k === "memory.highTokens") int(k, 20_000, 2_000_000);
+    else if (k === "memory.lowTokens") int(k, 5_000, 1_000_000);
+    else if (k === "routing.failover") {
       if (input[k] !== "auto" && input[k] !== "off") errors.push({ field: k, message: "must be auto or off" });
       else clean[k] = input[k];
     } else if (k === "routing.retries") int(k, 0, 5);
@@ -1130,6 +1154,14 @@
   if (("guard.highTokens" in clean || "guard.lowTokens" in clean) && lo >= hi) {
     errors.push({ field: "guard.lowTokens", message: "must be lower than guard.highTokens" });
   }
+  const mhi = Number(clean["memory.highTokens"] ?? cur["memory.highTokens"]);
+  const mlo = Number(clean["memory.lowTokens"] ?? cur["memory.lowTokens"]);
+  if (("memory.highTokens" in clean || "memory.lowTokens" in clean) && mlo >= mhi) {
+    errors.push({ field: "memory.lowTokens", message: "must be lower than memory.highTokens" });
+  }
+  if (("memory.mode" in clean || "memory.model" in clean) && (clean["memory.mode"] ?? cur["memory.mode"]) === "on" && !String(clean["memory.model"] ?? cur["memory.model"])) {
+    errors.push({ field: "memory.model", message: "choose the model that writes the summaries before switching memory on" });
+  }
   if (errors.length) throw new ValidationError(errors);
   for (const [k, v] of Object.entries(clean)) setSetting(k, v);
   if ("history.retentionDays" in clean) history.pruneOld();
````

### `package.json` — npm script smoke:memory

````diff
--- a/package.json
+++ b/package.json
@@ -13,10 +13,11 @@
     "check": "tsc --noEmit",
     "smoke": "npm run -s build && node scripts/smoke.mjs",
     "smoke:admin": "npm run -s build && node scripts/admin-smoke.mjs",
-    "smoke:all": "npm run -s smoke && npm run -s smoke:admin && npm run -s smoke:guard && npm run -s smoke:routing && npm run -s smoke:capacity",
+    "smoke:all": "npm run -s smoke && npm run -s smoke:admin && npm run -s smoke:guard && npm run -s smoke:routing && npm run -s smoke:capacity && npm run -s smoke:memory",
     "smoke:guard": "npm run -s build && node scripts/guard-smoke.mjs",
     "smoke:routing": "npm run -s build && node scripts/routing-smoke.mjs",
-    "smoke:capacity": "npm run -s build && node scripts/capacity-smoke.mjs"
+    "smoke:capacity": "npm run -s build && node scripts/capacity-smoke.mjs",
+    "smoke:memory": "npm run -s build && node scripts/memory-smoke.mjs"
   },
   "license": "ISC",
   "type": "commonjs",
````

## Verify

```bash
npx tsc --noEmit                    # no output
npm run build                       # built
node scripts/smoke.mjs && node scripts/admin-smoke.mjs && node scripts/guard-smoke.mjs && node scripts/routing-smoke.mjs && node scripts/capacity-smoke.mjs && node scripts/memory-smoke.mjs   # ALL PASSED x6
```
`memory-smoke.mjs` has 42 checks through the real router with a mock upstream (mock summariser, recorded main-model bodies): defaults and settings validation (memory on without a model refused, low >= high refused, non-boolean flags refused); anatomy stored and aggregated; shadow mode reports the tokens it would save (about 50K on the test conversation), calls no model and changes nothing; on mode: the crossing request is untouched, exactly one background summariser call, it receives readable text not raw JSON, the stored summary keeps the original request verbatim; the next request drops from 81 to 11 messages (215 KB to 27 KB), is still a valid conversation, the newest messages are byte-identical, history records ~52K tokens saved; the same conversation again gives identical text and no new summary call; a grown conversation starts with the same summary; another session gets nothing; a rewritten history ignores the stale summary; cascade builds the second summary from the first; summariser failure leaves the request unchanged and does not retry-storm; three parallel requests make one summary; forgetting a session works; summary calls are visible in History; old `Write` input cleared but path kept, conversation still valid, switch off leaves it alone; paste trimming off by default, first and newest two messages untouched, deterministic. These use a fake provider: the real summary quality depends on the model you choose.
