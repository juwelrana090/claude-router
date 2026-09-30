import crypto from "node:crypto";
import type { IncomingMessage } from "node:http";
import { estimateTokens } from "./contextGuard";
import { getCfg } from "./config";
import { costOf } from "./pricing";
import { db, getSetting } from "./db";
import * as history from "./history";
import { callOnce } from "./openai";
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
  const payload = { model: alias, max_tokens: 2000, system: SYSTEM, messages: [{ role: "user", content: prompt }], stream: false };
  let status: number, raw: string, j: Json;
  if (p.protocol === "openai") {
    const r = await callOnce(m, p, key, payload, AbortSignal.timeout(90_000));
    status = r.status; raw = r.raw; j = r.json;
  } else {
    const res = await fetch(`${p.baseURL}/v1/messages`, {
      method: "POST", headers: buildHeaders(fakeReq, p, key), body: buildBody(payload, m, p), signal: AbortSignal.timeout(90_000),
    });
    status = res.status; raw = await res.text();
    j = res.ok ? JSON.parse(raw) : null;
  }
  if (status < 200 || status >= 300 || !j) throw new Error(`HTTP ${status} from ${m.provider}: ${raw.slice(0, 120).replace(/[A-Za-z0-9_-]{28,}/g, "[redacted]")}`);
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