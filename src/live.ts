import type { ServerResponse } from "node:http";

/** One step of a request's journey through the route chain (shown in History). */
export interface TraceStep {
  route: string;
  key?: string;
  outcome: "served" | "skipped" | "failed" | "retry";
  status?: number;
  detail?: string;
}

export interface InFlight {
  id: string;
  alias: string;
  provider: string;
  model: string;
  keyName: string;
  startedAt: number;
  stream: boolean;
  status: "connecting" | "streaming";
  failover?: { from: string; status: number; reason: string };
  // ---- live task time / eta (all optional so existing constructors stay safe) ----
  sessionId?: string | null;
  maxTokens?: number;
  clientStartedAt?: number;
  firstTokenAt?: number | null;
  outSoFar?: number;
  tokensPerSec?: number | null;
  etaMs?: number | null;
  expectedOutputTokens?: number | null;
  streamError?: boolean;
  // context guard numbers for the history row
  guardSaved?: number;
  guardWould?: number;
  // router memory (rolling summary) numbers and what the prompt was made of
  memorySaved?: number;
  memoryWould?: number;
  anatomy?: import("./anatomy").Anatomy;
  // routing visibility: what the client asked for and how the router got to the route that answered
  askedAlias?: string;
  requestedModel?: string;
  resolvedVia?: string;
  trace?: TraceStep[];
}

export interface RecentEntry {
  ts: number;
  alias: string;
  provider: string;
  model: string;
  key: string;
  status: number;
  ms: number;
  in: number;
  out: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  failover?: { from: string; status: number; reason: string };
  // ---- live task time / eta ----
  sessionId?: string | null;
  startedAt?: number;
  firstTokenAt?: number | null;
  ttftMs?: number | null;
  durationMs?: number;
  outputTokensPerSec?: number | null;
}

// ---------- cooldowns (key env name -> epoch ms when it frees up) ----------
export const cooldown = new Map<string, number>();
/** Why a key is resting (shown in the Keys dialog and in request traces). */
export const coolInfo = new Map<string, { status: number; reason: string; at: number }>();
const failStreak = new Map<string, number>();

export function cool(key: string, ms: number, info?: { status: number; reason: string }): void {
  cooldown.set(key, Date.now() + ms);
  if (info) coolInfo.set(key, { ...info, at: Date.now() });
  failStreak.set(key, (failStreak.get(key) ?? 0) + 1);
}

export const streakOf = (key: string): number => failStreak.get(key) ?? 0;
export function noteSuccess(key: string): void {
  failStreak.delete(key);
  coolInfo.delete(key);
}
export const coolInfoFor = (key: string) => (cooldownLeft(key) > 0 ? coolInfo.get(key) : undefined);

export function cooldownLeft(key: string): number {
  return Math.max(0, (cooldown.get(key) ?? 0) - Date.now());
}

export function resetCooldown(key: string): boolean {
  failStreak.delete(key);
  coolInfo.delete(key);
  return cooldown.delete(key);
}

// ---------- ring buffers (memory only, no disk I/O on the hot path) ----------
export const RECENT_MAX = 200;
export const inFlight = new Map<string, InFlight>();
export const recent: RecentEntry[] = [];

const lastUsedByProvider = new Map<string, number>();
const lastUsedByKey = new Map<string, number>();

// One bucket per minute, trimmed to the last hour -> O(1) rollups.
interface Bucket {
  requests: number;
  errors: number;
  in: number;
  out: number;
  byProvider: Map<string, Bucket>;
}
const BUCKET_MS = 60_000;
const BUCKETS = 60;
const buckets = new Map<number, Bucket>();

const newBucket = (): Bucket => ({ requests: 0, errors: 0, in: 0, out: 0, byProvider: new Map() });

export interface Rollup {
  requests: number;
  errors: number;
  in: number;
  out: number;
  errorRate: number;
}

function bump(ts: number, patch: Partial<Omit<Bucket, "byProvider">>, provider?: string): void {
  const min = Math.floor(ts / BUCKET_MS);
  let b = buckets.get(min);
  if (!b) {
    b = newBucket();
    buckets.set(min, b);
  }
  b.requests += patch.requests ?? 0;
  b.errors += patch.errors ?? 0;
  b.in += patch.in ?? 0;
  b.out += patch.out ?? 0;
  if (provider) {
    const pb = b.byProvider.get(provider) ?? newBucket();
    pb.requests += patch.requests ?? 0;
    pb.errors += patch.errors ?? 0;
    b.byProvider.set(provider, pb);
  }
  if (buckets.size > BUCKETS) {
    for (const k of buckets.keys()) if (k < min - BUCKETS) buckets.delete(k);
  }
}

function rollRange(minutes: number, pick: (b: Bucket) => Bucket | undefined): Rollup {
  const nowMin = Math.floor(Date.now() / BUCKET_MS);
  const first = nowMin - minutes + 1;
  const r: Rollup = { requests: 0, errors: 0, in: 0, out: 0, errorRate: 0 };
  for (const [min, b] of buckets) {
    if (min < first || min > nowMin) continue;
    const src = pick(b);
    if (!src) continue;
    r.requests += src.requests;
    r.errors += src.errors;
    r.in += src.in;
    r.out += src.out;
  }
  r.errorRate = r.requests ? r.errors / r.requests : 0;
  return r;
}

export function rollup(minutes: number): Rollup {
  return rollRange(minutes, (b) => b);
}

export function providerRollup(provider: string, minutes: number): Rollup {
  return rollRange(minutes, (b) => b.byProvider.get(provider));
}

let seq = 0;

// ---------- hooks ----------
// Every hook is wrapped: a bug in here must never fail a /v1/messages request.
function guard(what: string, fn: () => void): void {
  try {
    fn();
  } catch (e) {
    console.warn(`[LIVE] ${what} failed:`, e instanceof Error ? e.message : String(e));
  }
}

export function startRequest(init: Omit<InFlight, "id">): InFlight {
  const entry: InFlight = { id: `r${(++seq).toString(36)}-${Date.now().toString(36)}`, ...init };
  guard("start", () => {
    inFlight.set(entry.id, entry);
    lastUsedByProvider.set(entry.provider, Date.now());
    lastUsedByKey.set(entry.keyName, Date.now());
    broadcast("start", entry);
  });
  return entry;
}

export function markStreaming(id: string): void {
  if (!id) return;
  guard("streaming", () => {
    const f = inFlight.get(id);
    if (!f) return;
    f.status = "streaming";
    broadcast("update", f);
  });
}

/** Remember that this in-flight request already burned a key/route, and why. */
export function setFailover(id: string, from: { from: string; status: number; reason: string }): void {
  if (!id) return;
  guard("failover", () => {
    const f = inFlight.get(id);
    if (!f) return;
    f.failover = from;
    broadcast("failover", { id, ...from, alias: f.alias, provider: f.provider, model: f.model });
  });
}

// Persistence hook (history.ts registers it; kept as a hook so live.ts has no database dependency).
let onFinish: ((id: string, e: RecentEntry, f?: InFlight) => void) | undefined;
export function setFinishHook(fn: (id: string, e: RecentEntry, f?: InFlight) => void): void {
  onFinish = fn;
}

export function finishRequest(id: string, entry: Omit<RecentEntry, "ts" | "failover">): void {
  if (!id) return;
  guard("finish", () => {
    const f = inFlight.get(id);
    inFlight.delete(id);
    const full: RecentEntry = { ts: Date.now(), ...entry, failover: f?.failover };
    if (full.failover === undefined) delete full.failover;
    onFinish?.(id, full, f);
    recent.push(full);
    while (recent.length > RECENT_MAX) recent.shift();
    lastUsedByProvider.set(full.provider, Date.now());
    lastUsedByKey.set(full.key, Date.now());
    bump(full.ts, {
      requests: 1,
      errors: full.status >= 400 ? 1 : 0,
      in: full.in,
      out: full.out,
    }, full.provider);
    // Final `eta` frame: total time is authoritative here, etaMs is always null.
    const t0 = f?.clientStartedAt ?? f?.startedAt ?? full.startedAt ?? full.ts - (full.durationMs ?? full.ms);
    const elapsedMs = full.durationMs ?? full.ms;
    broadcast("eta", {
      requestId: id,
      sessionId: full.sessionId ?? null,
      alias: full.alias,
      provider: full.provider,
      model: full.model,
      status: full.status >= 400 || f?.streamError ? "error" : "done",
      startedAt: t0,
      elapsedMs,
      durationMs: elapsedMs,
      firstTokenAt: full.firstTokenAt ?? f?.firstTokenAt ?? null,
      ttftMs: full.ttftMs ?? null,
      etaMs: null,
      expectedOutputTokens: f?.expectedOutputTokens ?? null,
      outputTokensSoFar: full.out,
      tokensPerSec: full.outputTokensPerSec
        ?? (full.ms > 0 && full.out > 0 ? Math.round((full.out / (full.ms / 1000)) * 100) / 100 : null),
      failover: full.failover ?? null,
      // Token counts ride the terminal frame so the UI can show a finished row without a refetch.
      httpStatus: full.status,
      inTokens: full.in,
      cacheRead: full.cacheRead,
      cacheWrite: full.cacheWrite,
      ctxTokens: full.in + full.cacheRead + full.cacheWrite,
      cost: full.cost,
    });
    broadcast("finish", full);
  });
}

export function lastUsedProvider(name: string): number | undefined {
  return lastUsedByProvider.get(name);
}
export function lastUsedKey(name: string): number | undefined {
  return lastUsedByKey.get(name);
}

// ---------- SSE hub ----------
export const MAX_SSE_CLIENTS = 5;
let nextClientId = 0;
const clients = new Map<number, ServerResponse>();

export function sseClientCount(): number {
  return clients.size;
}

export function addClient(res: ServerResponse): number | undefined {
  if (clients.size >= MAX_SSE_CLIENTS) return undefined;
  const id = ++nextClientId;
  clients.set(id, res);
  return id;
}

export function dropClient(id: number): void {
  clients.get(id)?.end();
  clients.delete(id);
}

export function broadcast(event: string, data: unknown): void {
  if (!clients.size) return;
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const [id, res] of clients) {
    try {
      res.write(frame);
    } catch {
      clients.delete(id);
    }
  }
}
