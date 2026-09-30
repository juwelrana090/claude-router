import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./config";
import { guardStats } from "./contextGuard";
import { db, getSetting } from "./db";
import type { InFlight, RecentEntry } from "./live";

const insert = db.prepare(`INSERT OR REPLACE INTO requests
  (id, session_id, alias, provider, model, key_name, status, stream, failover, started_at, first_token_at,
   ended_at, duration_ms, ttft_ms, in_tokens, out_tokens, cache_read, cache_write, ctx_tokens, cost, tps,
    guard_saved, guard_would, asked_alias, requested_model, resolved_via, trace,
   memory_saved, memory_would, anatomy)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);

/** Called for every finished request, including failures and aborts. Never throws. */
export function recordFinished(id: string, e: RecentEntry, f?: InFlight): void {
  try {
    const dur = e.durationMs ?? e.ms;
    insert.run(
      id, e.sessionId ?? null, e.alias, e.provider, e.model, e.key, e.status,
      f?.stream ? 1 : 0, e.failover || f?.failover ? 1 : 0,
      e.startedAt ?? e.ts - dur, e.firstTokenAt ?? null, e.ts, dur, e.ttftMs ?? null,
      e.in, e.out, e.cacheRead, e.cacheWrite, e.in + e.cacheRead + e.cacheWrite, e.cost, e.outputTokensPerSec ?? null,
      f?.guardSaved ?? 0, f?.guardWould ?? 0,
    f?.askedAlias ?? null, f?.requestedModel ?? null, f?.resolvedVia ?? null,
      f?.trace?.length ? JSON.stringify(f.trace) : null,
    f?.memorySaved ?? 0, f?.memoryWould ?? 0, f?.anatomy ? JSON.stringify(f.anatomy) : null,
    );
  } catch (err) {
    console.warn("[HISTORY] write failed:", (err as Error).message);
  }
}

export interface HistoryRow {
  id: string; sessionId: string | null; alias: string; provider: string; model: string; key: string | null;
  status: number; stream: boolean; failover: boolean; startedAt: number; firstTokenAt: number | null;
  endedAt: number; durationMs: number | null; ttftMs: number | null; in: number; out: number;
  cacheRead: number; cacheWrite: number; ctx: number; cost: number; tps: number | null;
  guardSaved: number; guardWould: number;
  /** Alias the client's model name resolved to (what you asked for). `alias` is what answered. */
  askedAlias: string | null; requestedModel: string | null; resolvedVia: string | null;
  trace: { route: string; key?: string; outcome: string; status?: number; detail?: string }[];
  memorySaved: number; memoryWould: number;
  /** Estimated prompt tokens by part, as the client sent it. */
  anatomy: Record<string, number> | null;
}

type Row = Record<string, string | number | null>;
const toRow = (r: Row): HistoryRow => ({
  id: r.id as string, sessionId: r.session_id as string | null, alias: r.alias as string,
  provider: r.provider as string, model: r.model as string, key: r.key_name as string | null,
  status: r.status as number, stream: !!r.stream, failover: !!r.failover,
  startedAt: r.started_at as number, firstTokenAt: r.first_token_at as number | null,
  endedAt: r.ended_at as number, durationMs: r.duration_ms as number | null, ttftMs: r.ttft_ms as number | null,
  in: r.in_tokens as number, out: r.out_tokens as number, cacheRead: r.cache_read as number,
  cacheWrite: r.cache_write as number, ctx: r.ctx_tokens as number, cost: r.cost as number, tps: r.tps as number | null,
  guardSaved: r.guard_saved as number, guardWould: r.guard_would as number,
  askedAlias: (r.asked_alias as string | null) ?? null, requestedModel: (r.requested_model as string | null) ?? null,
  resolvedVia: (r.resolved_via as string | null) ?? null,
  trace: (() => { try { return r.trace ? JSON.parse(r.trace as string) : []; } catch { return []; } })(),
  memorySaved: (r.memory_saved as number) ?? 0, memoryWould: (r.memory_would as number) ?? 0,
  anatomy: (() => { try { return r.anatomy ? JSON.parse(r.anatomy as string) : null; } catch { return null; } })(),
});

export interface HistoryQuery {
  limit?: number; offset?: number; before?: number; status?: "ok" | "error"; alias?: string; provider?: string;
  q?: string; minCtx?: number;
}

export function listRequests(q: HistoryQuery): { rows: HistoryRow[]; hasMore: boolean; total: number } {
  const limit = Math.min(Math.max(Math.floor(q.limit ?? 50), 1), 500);
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (q.status === "ok") where.push("status < 400");
  if (q.status === "error") where.push("status >= 400");
  if (q.alias) { where.push("alias = ?"); args.push(q.alias); }
  if (q.provider) { where.push("provider = ?"); args.push(q.provider); }
  if (q.minCtx) { where.push("ctx_tokens >= ?"); args.push(q.minCtx); }
  if (q.q) {
      where.push("(alias LIKE ? OR model LIKE ? OR provider LIKE ? OR id LIKE ? OR session_id LIKE ? OR requested_model LIKE ?)");
      const like = `%${q.q.replace(/[%_]/g, "")}%`;
      args.push(like, like, like, like, like, like);
  }
  const base = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM requests ${base}`).get(...args) as { n: number }).n;
  const paged = q.before ? `${base ? base + " AND" : "WHERE"} ended_at < ?` : base;
  const offset = Math.max(0, Math.floor(q.offset ?? 0));
  // Stable order: rows that end in the same millisecond are tie-broken by id, so pages never overlap or skip.
  const rows = db.prepare(`SELECT * FROM requests ${paged} ORDER BY ended_at DESC, id DESC LIMIT ? OFFSET ?`)
    .all(...args, ...(q.before ? [q.before] : []), limit + 1, offset) as unknown as Row[];
  return { rows: rows.slice(0, limit).map(toRow), hasMore: rows.length > limit, total };
}

const pct = (sorted: number[], p: number): number =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : 0;

/** Token/context analytics over a time window. All numbers come from the request history. */
export function insights(sinceMs: number) {
  const since = Date.now() - sinceMs;
  const rows = db.prepare(
    "SELECT session_id, started_at, ended_at, status, in_tokens, out_tokens, cache_read, cache_write, ctx_tokens, cost FROM requests WHERE ended_at >= ? ORDER BY session_id, started_at",
  ).all(since) as unknown as Row[];

  const t = { requests: 0, errors: 0, fresh: 0, out: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  const ctxs: number[] = [];
  const warn = Number(getSetting("context.warnTokens"));
  let overWarn = 0, compactions = 0;
  const sessions = new Map<string, { requests: number; ctxTotal: number; maxCtx: number; startedAt: number; endedAt: number }>();
  let prevSession: unknown = null, prevCtx = 0;
  const hourly = new Map<number, { t: number; requests: number; ctx: number; out: number; cacheRead: number }>();

  for (const r of rows) {
    const ctx = r.ctx_tokens as number;
    t.requests++; if ((r.status as number) >= 400) t.errors++;
    t.fresh += r.in_tokens as number; t.out += r.out_tokens as number;
    t.cacheRead += r.cache_read as number; t.cacheWrite += r.cache_write as number; t.cost += r.cost as number;
    if (ctx > 0) ctxs.push(ctx);
    if (ctx >= warn) overWarn++;
    // A compaction shows up as the context of the next request in a session collapsing.
    if (r.session_id === prevSession && prevCtx > 20_000 && ctx < prevCtx * 0.6) compactions++;
    prevSession = r.session_id; prevCtx = ctx;
    const sid = String(r.session_id ?? "unknown");
    const s = sessions.get(sid) ?? { requests: 0, ctxTotal: 0, maxCtx: 0, startedAt: r.started_at as number, endedAt: 0 };
    s.requests++; s.ctxTotal += ctx; s.maxCtx = Math.max(s.maxCtx, ctx);
    s.startedAt = Math.min(s.startedAt, r.started_at as number); s.endedAt = Math.max(s.endedAt, r.ended_at as number);
    sessions.set(sid, s);
    const bucket = Math.floor((r.ended_at as number) / 3600_000) * 3600_000;
    const h = hourly.get(bucket) ?? { t: bucket, requests: 0, ctx: 0, out: 0, cacheRead: 0 };
    h.requests++; h.ctx += ctx; h.out += r.out_tokens as number; h.cacheRead += r.cache_read as number;
    hourly.set(bucket, h);
  }
  ctxs.sort((a, b) => a - b);
  const input = t.fresh + t.cacheRead + t.cacheWrite;
  return {
    since, warnTokens: warn,
    totals: { ...t, input, cacheHitPct: input ? (t.cacheRead / input) * 100 : 0 },
    context: {
      avg: ctxs.length ? Math.round(input / ctxs.length) : 0,
      p50: pct(ctxs, 0.5), p90: pct(ctxs, 0.9), max: ctxs.length ? ctxs[ctxs.length - 1] : 0,
      overWarn, compactions,
    },
      guard: guardStats(sinceMs),
      memory: memoryStats(since),
      anatomy: anatomyTotals(since),
    topSessions: [...sessions.entries()]
      .map(([sessionId, s]) => ({ sessionId, ...s }))
      .sort((a, b) => b.ctxTotal - a.ctxTotal).slice(0, 5),
    hourly: [...hourly.values()].sort((a, b) => a.t - b.t),
  };
}

/** Start of "today" on the router's own clock. Daily limits reset at this moment. */
export function startOfToday(now = Date.now()): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

const todayStmt = db.prepare(
  `SELECT COUNT(*) AS n, COALESCE(SUM(in_tokens + out_tokens + cache_read + cache_write), 0) AS t
     FROM requests WHERE provider = ? AND ended_at >= ? AND status < 400`,
);

/** What a provider has served since local midnight (successful requests only). */
export function providerToday(provider: string): { requests: number; tokens: number } {
  const r = todayStmt.get(provider, startOfToday()) as { n: number; t: number };
  return { requests: r.n, tokens: r.t };
}

/** Router memory over a window: tokens removed, tokens it would remove (shadow), and what the summaries cost. */
export function memoryStats(since: number) {
  const r = db.prepare(
    `SELECT COALESCE(SUM(memory_saved),0) AS s, COALESCE(SUM(memory_would),0) AS w,
           SUM(CASE WHEN memory_saved > 0 OR memory_would > 0 THEN 1 ELSE 0 END) AS n FROM requests WHERE ended_at >= ?`,
  ).get(since) as { s: number; w: number; n: number | null };
  const m = db.prepare(
    `SELECT COUNT(*) AS n, COALESCE(SUM(source_tokens),0) AS src, COALESCE(SUM(summary_tokens),0) AS sum, COALESCE(SUM(cost),0) AS cost
      FROM memory_summaries WHERE created_at >= ?`,
  ).get(since) as { n: number; src: number; sum: number; cost: number };
  return { requests: r.n ?? 0, saved: r.s, would: r.w, summaries: m.n, summarisedTokens: m.src, summaryTokens: m.sum, cost: m.cost };
}

/** Average tokens of each prompt part over the most recent 2000 requests in the window. */
export function anatomyTotals(since: number) {
  const rows = db.prepare("SELECT anatomy FROM requests WHERE ended_at >= ? AND anatomy IS NOT NULL ORDER BY ended_at DESC LIMIT 2000").all(since) as unknown as { anatomy: string }[];
  const sum: Record<string, number> = {};
  let n = 0;
  for (const r of rows) {
    try {
      const a = JSON.parse(r.anatomy) as Record<string, number>;
      for (const [k, v] of Object.entries(a)) sum[k] = (sum[k] ?? 0) + v;
      n++;
    } catch { /* skip */ }
  }
  const avg: Record<string, number> = {};
  for (const [k, v] of Object.entries(sum)) avg[k] = n ? Math.round(v / n) : 0;
  return { requests: n, average: avg };
}

// ---------- housekeeping ----------
export function pruneOld(): number {
  const days = Number(getSetting("history.retentionDays"));
  if (!(days > 0)) return 0;
  const r = db.prepare("DELETE FROM requests WHERE ended_at < ?").run(Date.now() - days * 86400_000);
  return Number(r.changes);
}

export function clearAll(): number {
  return Number(db.prepare("DELETE FROM requests").run().changes);
}

/** First run: pull the existing logs/usage.jsonl into the history so it is not empty. */
export function backfillFromJsonl(): number {
  const file = path.join(ROOT, "logs", "usage.jsonl");
  const empty = (db.prepare("SELECT COUNT(*) AS n FROM requests").get() as { n: number }).n === 0;
  if (!empty || !fs.existsSync(file)) return 0;
  let n = 0;
  db.exec("BEGIN");
  try {
    let i = 0;
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const j = JSON.parse(line);
        const ended = Date.parse(j.ts);
        if (!Number.isFinite(ended)) continue;
        const dur = Number(j.durationMs ?? j.ms ?? 0);
        insert.run(
          `jsonl-${++i}`, j.sessionId ?? null, j.alias, j.provider, j.model, j.key ?? null, j.status ?? 200, 1, 0,
          j.startedAt ? Date.parse(j.startedAt) : ended - dur, j.firstTokenAt ? Date.parse(j.firstTokenAt) : null,
          ended, dur, j.ttftMs ?? null, j.in ?? 0, j.out ?? 0, j.cacheRead ?? 0, j.cacheWrite ?? 0,
          (j.in ?? 0) + (j.cacheRead ?? 0) + (j.cacheWrite ?? 0), j.cost ?? 0, j.outputTokensPerSec ?? null, 0, 0,
          null, null, null, null, 0, 0, null,
          );
        n++;
      } catch { /* skip malformed line */ }
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    console.warn("[HISTORY] backfill failed:", (e as Error).message);
    return 0;
  }
  return n;
}
