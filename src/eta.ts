import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

import { ROOT } from "./config";
import * as live from "./live";

// ---------- live task time / eta ----------
// History rings + sessions + ETA math + the single 1s ticker. All state is in
// memory; rings re-seed read-only from logs/usage.jsonl at startup. Every hook
// is best-effort: a bug in here must never fail a /v1/messages request.

const HISTORY_N = 50; // last successful requests per provider/model
const MIN_HISTORY = 5; // below this: "estimating...", never a fabricated number
const MIN_ETA_MS = 3000; // never show negative or 0 while running
const MAX_ETA_MS = 600_000; // cap: a stalled stream must not advertise hours
const SESSION_IDLE_MS = 30 * 60_000; // idle gap that starts a new session window
const SESSIONS_MAX = 100; // LRU cap on tracked sessions

interface Ring { tps: number[]; ttft: number[]; out: number[] }
const rings = new Map<string, Ring>();

function r2(x: number): number {
  return Math.round(x * 100) / 100;
}

function median(a: number[]): number {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

const clampEta = (ms: number): number => Math.min(MAX_ETA_MS, Math.max(MIN_ETA_MS, Math.round(ms)));

// A sub-second window wildly overstates speed (outSoFar over a 0.25s floor),
// which made the first post-token ETA visibly jump upward before collapsing
// back. Live speed needs at least one full ticker period of samples.
const LIVE_MIN_WINDOW_MS = 1000;

/** Live output tokens/sec, or null until there is a window worth dividing by. */
function liveSpeedOf(f: live.InFlight, now: number): number | null {
  const out = f.outSoFar ?? 0;
  if (!f.firstTokenAt || out <= 0) return null;
  const windowMs = now - f.firstTokenAt;
  if (windowMs < LIVE_MIN_WINDOW_MS) return null;
  return out / (windowMs / 1000);
}

function ring(provider: string, model: string): Ring {
  const k = `${provider}/${model}`;
  let r = rings.get(k);
  if (!r) {
    r = { tps: [], ttft: [], out: [] };
    rings.set(k, r);
  }
  return r;
}

function pushCapped(arr: number[], v: number): void {
  arr.push(v);
  if (arr.length > HISTORY_N) arr.shift();
}

/** Feed one successful sample into the history rings (streaming-only for ttft). */
export function feedHistory(
  provider: string,
  model: string,
  sample: { status: number; out: number; ttftMs?: number | null; outputTokensPerSec?: number | null; aborted?: boolean }
): void {
  // A mid-stream abort is a partial answer, not a sample of what this model
  // delivers: it must not shape the ETA history.
  if (sample.aborted || sample.status >= 400 || !(sample.out > 0)) return;
  const r = ring(provider, model);
  pushCapped(r.out, sample.out);
  if (sample.outputTokensPerSec && sample.outputTokensPerSec > 0) pushCapped(r.tps, sample.outputTokensPerSec);
  if (sample.ttftMs && sample.ttftMs > 0) pushCapped(r.ttft, sample.ttftMs);
}

/** ETA for an in-flight request, or null when there is not enough to go on. */
function computeEta(f: live.InFlight, now: number): { etaMs: number | null; expected: number | null } {
  const r = rings.get(`${f.provider}/${f.model}`) ?? { tps: [], ttft: [], out: [] };
  const medTps = median(r.tps);
  const medTtft = median(r.ttft);
  const medOut = median(r.out);
  const maxTokens = f.maxTokens && f.maxTokens > 0 ? f.maxTokens : 0;
  const outSoFar = f.outSoFar ?? 0;

  // Expected output length: historical median, capped by the request max_tokens.
  let expected: number | null = null;
  if (medOut > 0 && maxTokens > 0) expected = Math.min(medOut, maxTokens);
  else if (medOut > 0) expected = medOut;
  else if (maxTokens > 0) expected = maxTokens;

  const hasHistory = r.tps.length >= MIN_HISTORY;
  const liveSpeed = liveSpeedOf(f, now);
  // 70/30 blend between live speed and the historical median speed.
  const blend = liveSpeed !== null && medTps > 0
    ? 0.7 * liveSpeed + 0.3 * medTps
    : liveSpeed ?? (medTps > 0 ? medTps : null);

  let etaMs: number | null = null;
  if (!f.firstTokenAt) {
    // Pre-first-token: pure historical estimate once enough samples exist.
    if (hasHistory && medTps > 0 && expected !== null) etaMs = clampEta(medTtft + (expected / medTps) * 1000);
  } else if (hasHistory && blend !== null && blend > 0.1 && expected !== null) {
    // Same MIN_HISTORY gate as pre-token: below 5 samples stay on "estimating...".
    etaMs = clampEta((Math.max(1, expected - outSoFar) / blend) * 1000);
  }
  return { etaMs, expected };
}

function etaFrame(f: live.InFlight, now: number, etaMs: number | null, expected: number | null) {
  const startedAt = f.clientStartedAt ?? f.startedAt;
  return {
    requestId: f.id,
    sessionId: f.sessionId ?? null,
    alias: f.alias,
    askedAlias: f.askedAlias ?? null,
    provider: f.provider,
    model: f.model,
    status: "running" as const,
    startedAt,
    elapsedMs: Math.max(0, now - startedAt),
    firstTokenAt: f.firstTokenAt ?? null,
    ttftMs: f.firstTokenAt ? Math.max(0, f.firstTokenAt - startedAt) : null,
    etaMs,
    expectedOutputTokens: expected,
    outputTokensSoFar: f.outSoFar ?? 0,
    tokensPerSec: f.tokensPerSec ?? null,
    failover: f.failover ?? null,
  };
}

// ---------- one lazy 1s ticker for all in-flight requests ----------
let ticker: NodeJS.Timeout | null = null;

function stopTicker(): void {
  if (ticker) {
    clearInterval(ticker);
    ticker = null;
  }
}

function tick(): void {
  try {
    const now = Date.now();
    for (const f of live.inFlight.values()) {
      const { etaMs, expected } = computeEta(f, now);
      const speed = liveSpeedOf(f, now);
      f.expectedOutputTokens = expected;
      f.etaMs = etaMs;
      f.tokensPerSec = speed ? r2(speed) : null;
      live.broadcast("eta", etaFrame(f, now, etaMs, expected));
    }
  } catch (e) {
    console.warn("[ETA] tick failed:", e instanceof Error ? e.message : String(e));
  } finally {
    if (!live.inFlight.size) stopTicker();
  }
}

function ensureTicker(): void {
  if (!ticker && live.inFlight.size) {
    ticker = setInterval(tick, 1000);
    ticker.unref();
  }
}

// ---------- per-request hooks (synchronous O(1) map writes) ----------
export function begin(f: live.InFlight): void {
  try {
    if (f.outSoFar === undefined) f.outSoFar = 0;
    if (f.firstTokenAt === undefined) f.firstTokenAt = null;
    sessionOpen(f);
    ensureTicker();
  } catch { /* never fail the request path */ }
}

/** Open the session window at request start so the statusline/UI session tail
 *  exists during the first (still-running) request, not only after it lands. */
function sessionOpen(f: live.InFlight): void {
  if (!f.sessionId) return;
  const now = Date.now();
  let s = sessions.get(f.sessionId);
  if (s && now - s.lastActiveAt > SESSION_IDLE_MS) s = undefined;
  if (s) return; // an already-open window is only ever bumped, never reset
  s = {
    sessionId: f.sessionId,
    startedAt: f.clientStartedAt ?? f.startedAt,
    lastActiveAt: now,
    requests: 0,
    totalMs: 0,
    tokensIn: 0,
    tokensOut: 0,
    cost: 0,
    lastProvider: f.provider,
    lastModel: f.model,
  };
  sessions.set(f.sessionId, s);
  while (sessions.size > SESSIONS_MAX) {
    const oldest = sessions.keys().next().value;
    if (oldest === undefined) break;
    sessions.delete(oldest);
  }
}

export function firstToken(id: string): void {
  if (!id) return;
  try {
    const f = live.inFlight.get(id);
    if (f && !f.firstTokenAt) f.firstTokenAt = Date.now();
  } catch { /* ignore */ }
}

export function noteOutput(id: string, out: number): void {
  if (!id) return;
  try {
    const f = live.inFlight.get(id);
    if (f && out > (f.outSoFar ?? 0)) f.outSoFar = out;
  } catch { /* ignore */ }
}

export function markError(id: string): void {
  if (!id) return;
  try {
    const f = live.inFlight.get(id);
    if (f) f.streamError = true;
  } catch { /* ignore */ }
}

// ---------- sessions ----------
interface Session {
  sessionId: string;
  startedAt: number;
  lastActiveAt: number;
  requests: number;
  totalMs: number;
  tokensIn: number;
  tokensOut: number;
  cost: number;
  lastProvider: string;
  lastModel: string;
}
const sessions = new Map<string, Session>();

function sessionView(s: Session, now: number) {
  return {
    sessionId: s.sessionId,
    startedAt: s.startedAt,
    elapsedMs: Math.max(0, now - s.startedAt),
    requests: s.requests,
    avgMsPerRequest: s.requests ? Math.round(s.totalMs / s.requests) : 0,
    tokensIn: s.tokensIn,
    tokensOut: s.tokensOut,
    cost: Math.round(s.cost * 1e6) / 1e6,
    lastProvider: s.lastProvider,
    lastModel: s.lastModel,
  };
}

/** Bump the session window with one successful request (30-min idle resets it). */
export function sessionBump(rec: {
  sessionId?: string | null;
  provider: string;
  model: string;
  in: number;
  out: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  ms: number;
  status: number;
  ts: number;
}): void {
  if (!rec.sessionId || rec.status >= 400) return;
  const now = rec.ts || Date.now();
  let s = sessions.get(rec.sessionId);
  if (s && now - s.lastActiveAt > SESSION_IDLE_MS) {
    s = undefined; // idle window elapsed -> fresh window under the same id
  }
  if (!s) {
    // The window opens when the first request started, not when it finished.
    const firstStart = rec.ms > 0 ? now - rec.ms : now;
    s = {
      sessionId: rec.sessionId,
      startedAt: firstStart,
      lastActiveAt: now,
      requests: 0,
      totalMs: 0,
      tokensIn: 0,
      tokensOut: 0,
      cost: 0,
      lastProvider: rec.provider,
      lastModel: rec.model,
    };
    sessions.set(rec.sessionId, s);
    while (sessions.size > SESSIONS_MAX) {
      const oldest = sessions.keys().next().value;
      if (oldest === undefined) break;
      sessions.delete(oldest);
    }
  }
  // re-insert to keep LRU order
  sessions.delete(rec.sessionId);
  sessions.set(rec.sessionId, s);
  s.lastActiveAt = now;
  s.requests++;
  s.totalMs += rec.ms > 0 ? rec.ms : 0;
  s.tokensIn += rec.in + rec.cacheRead + rec.cacheWrite;
  s.tokensOut += rec.out;
  s.cost += rec.cost;
  s.lastProvider = rec.provider;
  s.lastModel = rec.model;
}

/** The most recently active session, or null when idle for >30 min. */
export function activeSession() {
  try {
    const now = Date.now();
    const newest = [...sessions.values()].sort((a, b) => b.lastActiveAt - a.lastActiveAt)[0];
    if (!newest || now - newest.lastActiveAt > SESSION_IDLE_MS) return null;
    return sessionView(newest, now);
  } catch {
    return null;
  }
}

// ---------- snapshots ----------
export function etaSnapshot() {
  const now = Date.now();
  const running = [...live.inFlight.values()].map((f) => {
    const { etaMs, expected } = computeEta(f, now);
    const speed = liveSpeedOf(f, now);
    return {
      requestId: f.id,
      sessionId: f.sessionId ?? null,
      alias: f.alias,
      askedAlias: f.askedAlias ?? null,
      provider: f.provider,
      model: f.model,
      status: "running" as const,
      startedAt: f.clientStartedAt ?? f.startedAt,
      elapsedMs: Math.max(0, now - (f.clientStartedAt ?? f.startedAt)),
      etaMs,
      expectedOutputTokens: expected,
      outputTokensSoFar: f.outSoFar ?? 0,
      tokensPerSec: speed ? r2(speed) : null,
      firstTokenAt: f.firstTokenAt ?? null,
      ttftMs: f.firstTokenAt ? Math.max(0, f.firstTokenAt - (f.clientStartedAt ?? f.startedAt)) : null,
    };
  });
  return { ts: now, running, session: activeSession() };
}

/**
 * Startup: seed the rings read-only from logs/usage.jsonl (no rewrite/migration).
 * The promise resolves only once the log is fully ingested; index.ts opens the
 * port after it, so an early request never sees empty history against a
 * populated log. An unreadable log (EACCES, swapped file) degrades to empty
 * history instead of an uncaughtException that kills the router at startup.
 */
export function seedHistory(): Promise<void> {
  return new Promise((resolve) => {
    const file = path.join(ROOT, "logs", "usage.jsonl");
    if (!fs.existsSync(file)) {
      resolve();
      return;
    }
    const rl = readline.createInterface({
      input: fs.createReadStream(file, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });
    let done = false;
    const finish = () => {
      if (!done) {
        done = true;
        resolve();
      }
    };
    rl.on("line", (raw) => {
      const line = raw.trim();
      if (!line) return;
      try {
        const rec = JSON.parse(line) as {
          provider?: string; model?: string; status?: number; out?: number;
          ttftMs?: number | null; outputTokensPerSec?: number | null;
        };
        feedHistory(rec.provider ?? "unknown", rec.model ?? "unknown", {
          status: Number(rec.status) || 0,
          out: Number(rec.out) || 0,
          ttftMs: typeof rec.ttftMs === "number" ? rec.ttftMs : null,
          outputTokensPerSec: typeof rec.outputTokensPerSec === "number" ? rec.outputTokensPerSec : null,
        });
      } catch { /* corrupt line -> skip */ }
    });
    rl.on("error", (e) => {
      console.warn("[ETA] usage log unreadable -> seeding with empty history:",
        e instanceof Error ? e.message : String(e));
      finish();
    });
    rl.on("close", finish); // every line is fed synchronously, so close == seeded
  });
}
