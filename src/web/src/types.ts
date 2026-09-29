/**
 * Wire contracts of the claude-router admin API.
 * Source of truth: the running router (see /admin/snapshot, /admin/events, /admin/eta,
 * /admin/usage/summary). Keep these in sync with the server, not the other way around.
 */

// ---------- Live SSE (/admin/events, event name "eta") ----------

export type EtaStatus = 'running' | 'done' | 'error';

/**
 * One eta event per running request (>=1/sec) plus exactly one terminal event.
 * etaMs is null while estimating, 3000..600000 once set, and ALWAYS null on terminal
 * events (durationMs carries the authoritative total there).
 */
export interface EtaEvent {
  requestId: string;
  sessionId: string;
  alias: string;
  provider: string;
  model: string;
  status: EtaStatus;
  startedAt: number;
  elapsedMs: number;
  firstTokenAt: number | null;
  ttftMs: number | null;
  etaMs: number | null;
  expectedOutputTokens: number | null;
  outputTokensSoFar: number;
  tokensPerSec: number | null;
  /** Terminal only. Authoritative total duration. */
  durationMs?: number;
  failover?: boolean;
}

// ---------- Session totals ----------

export interface SessionTotals {
  sessionId: string;
  startedAt: number;
  elapsedMs: number;
  requests: number;
  avgMsPerRequest: number;
  tokensIn: number;
  tokensOut: number;
  cost: number;
  lastProvider?: string;
  lastModel?: string;
}

// ---------- Snapshot (GET /admin/snapshot) ----------

export interface KeyInfo {
  name: string;
  disabled: boolean;
  healthy?: boolean;
}

export interface Provider {
  name: string;
  baseURL: string;
  auth: string;
  disabled: boolean;
  keysTotal: number;
  keysHealthy: number;
  keys: KeyInfo[];
  models: string[];
}

export interface ModelPrice {
  /** USD per million input tokens. */
  in: number;
  /** USD per million output tokens. */
  out: number;
}

export interface ModelRow {
  alias: string;
  provider: string;
  model: string;
  key?: string;
  keysTotal: number;
  keysHealthy: number;
  providerMissing?: boolean;
  maxOutputTokens?: number | null;
  fallback: string[];
  price: ModelPrice | null;
}

export interface Snapshot {
  version: number;
  providers: Provider[];
  models: ModelRow[];
  session: SessionTotals | null;
  inFlight: unknown[];
}

// ---------- ETA snapshot (GET /admin/eta) ----------

export interface EtaSnapshot {
  ts: number;
  running: EtaEvent[];
  session: SessionTotals | null;
}

// ---------- Usage (GET /admin/usage/summary?range=...) ----------

export type UsageRange = '1h' | '24h' | '7d' | '30d';

export interface UsageTotals {
  requests: number;
  in: number;
  out: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost: number;
  avgMs: number;
  avgTokensPerSec: number;
}

export interface UsageByNameRow {
  name: string;
  requests: number;
  in: number;
  out: number;
  cost: number;
  avgMs: number;
  avgTokensPerSec: number;
}

export interface DailyUsage {
  day: string;
  provider: string;
  alias: string;
  requests: number;
  avgMs: number;
  avgTokensPerSec: number;
}

export interface MonthlyUsage {
  month: string;
  provider: string;
  alias: string;
  requests: number;
  avgMs: number;
  avgTokensPerSec: number;
}

export interface UsageSummary {
  totals: UsageTotals;
  byAlias: UsageByNameRow[];
  byProvider: UsageByNameRow[];
  daily: DailyUsage[];
  monthly: MonthlyUsage[];
}

/** One usage record as written by the router (documented shape of the log rows). */
export interface UsageRecord {
  ts: number;
  alias: string;
  provider: string;
  model: string;
  status: string;
  ms: number;
  in: number;
  out: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  sessionId: string;
  durationMs?: number;
  ttftMs?: number;
  outputTokensPerSec?: number;
}

// ---------- Admin CRUD ----------

/** Bodies accepted by PUT/DELETE /admin/providers/:name and /admin/models/:alias. */
export interface VersionedBody {
  version: number;
}

export interface ProviderUpsertBody extends Partial<Omit<Provider, 'name' | 'keys' | 'keysTotal' | 'keysHealthy'>> {
  name: string;
}

export interface ModelUpsertBody extends Partial<Omit<ModelRow, 'alias'>> {
  alias: string;
}

export interface TestBody {
  provider: string;
  model: string;
}

export interface AddKeyBody {
  envName: string;
  value: string;
}
