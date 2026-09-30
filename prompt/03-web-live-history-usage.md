# 03 — Live (gauge + big numbers), History, Usage

**Run after 02.** Changes `src/web/` only.

## What this step adds and why

- **Live**: an always-visible 24-hour strip — requests, **prompt tokens sent** (`54.9M`; exact number and "54.86 million" on hover), **output tokens**, cost estimate. A **speedometer gauge** (ApexCharts radial bar) shows the combined tokens/second of everything running right now; the throughput chart stays; a **Context size** card shows typical/large/biggest prompt and warns when most requests exceed your limit; **Recent requests** now comes from the database (survives refresh and restart).
- **History** (new page): every request from the moment it starts (blue "Running" row) until it finishes (green/red), with context, fresh input, cache read, output, TTFT, duration, tok/s and cost; search, model and status filters, "load more", a details drawer.
- **Usage**: same token definitions as Live (**Prompt tokens sent = fresh + cache read**, shown with the split) — this removes the "Tokens in 630k here vs 58M there" confusion. New **Prompt size** panel: average, p50, p90, biggest, cache-hit %, compactions, biggest sessions.

## How to work (read this first)

- This file is **complete**. Everything you need is below. **Do not open, search or read any other file or folder.**
  If a step says "replace the whole file" you do not need to read the old one. If a step is a diff, open **only that one file** to apply it.
- Diffs are unified diffs with 3 lines of context. Apply each from the repo root with
  `git apply --ignore-whitespace --whitespace=nowarn <file.patch>` (save the block to a `.patch` file first), or edit by hand: `-` lines are removed, `+` lines are added, everything else is context.
  If a hunk does not match because the line already looks like the `+` version, skip that hunk and say so.
- Files in this repo use Windows line endings (CRLF). Keep each existing file's line endings. New files may use either.
- Do not change anything that is not listed. No refactors, no renames, no formatting changes.
- Never print, log, or commit `.env` values.
- When done, run the verification commands at the end and paste their **real output**. If one fails, fix only what the failure points to, then re-run it.

## Steps

### Step 1 — Create these new files

### `src/web/src/components/RequestTable.tsx` — NEW file

````tsx
import { Table, Tag, Tooltip, Typography } from 'antd';
import type { TableColumnsType } from 'antd';
import { fmtCompact, fmtDateTime, fmtExact, fmtMs, fmtPct, fmtTps, fmtUsd } from '../format';
import type { HistoryRow, RunningRow } from '../types';

export type Row = (HistoryRow & { running?: false }) | (RunningRow & { running: true; ctx?: undefined });

/** One row = one request, from the moment it starts (blue) until it finishes (green/red). */
export function requestColumns(warnTokens: number, onOpen?: (r: HistoryRow) => void): TableColumnsType<Row> {
  return [
    {
      title: 'Time',
      width: 128,
      render: (_, r) => <Typography.Text type="secondary">{fmtDateTime(r.running ? r.startedAt : r.endedAt)}</Typography.Text>,
    },
    {
      title: 'Status',
      width: 96,
      render: (_, r) =>
        r.running ? (
          <Tag color="processing">Running</Tag>
        ) : r.status >= 400 ? (
          <Tag color="error">{r.status}</Tag>
        ) : (
          <Tag color="success">{r.status}</Tag>
        ),
    },
    {
      title: 'Model',
      render: (_, r) => (
        <div style={{ lineHeight: 1.3 }}>
          <Typography.Text strong>{r.alias}</Typography.Text>
          {r.failover && <Tag color="warning" style={{ marginLeft: 6 }}>failover</Tag>}
          <div><Typography.Text type="secondary" style={{ fontSize: 12 }}>{r.provider} · {r.model}</Typography.Text></div>
        </div>
      ),
    },
    {
      title: <Tooltip title="Whole prompt sent (fresh + cached). Every request re-sends the conversation, so this number is what drives token use.">Context</Tooltip>,
      width: 100,
      align: 'right',
      render: (_, r) =>
        r.running ? '…' : (
          <Tooltip title={`${fmtExact(r.ctx)} tokens (${fmtPct(r.ctx ? (r.cacheRead / r.ctx) * 100 : 0, 0)} from cache)`}>
            <span style={{ color: r.ctx >= warnTokens ? '#E0A344' : undefined, fontWeight: r.ctx >= warnTokens ? 600 : 400 }}>{fmtCompact(r.ctx)}</span>
          </Tooltip>
        ),
    },
    { title: 'Fresh in', width: 90, align: 'right', render: (_, r) => (r.running ? '…' : <Tooltip title={fmtExact(r.in)}>{fmtCompact(r.in)}</Tooltip>) },
    { title: 'Cache read', width: 96, align: 'right', render: (_, r) => (r.running ? '…' : <Tooltip title={fmtExact(r.cacheRead)}>{fmtCompact(r.cacheRead)}</Tooltip>) },
    {
      title: 'Out',
      width: 80,
      align: 'right',
      render: (_, r) => <Tooltip title={fmtExact(r.running ? r.outSoFar : r.out)}>{fmtCompact(r.running ? r.outSoFar : r.out)}</Tooltip>,
    },
    { title: 'TTFT', width: 84, align: 'right', render: (_, r) => (r.running ? '…' : fmtMs(r.ttftMs)) },
    { title: 'Duration', width: 90, align: 'right', render: (_, r) => (r.running ? fmtMs(Date.now() - r.startedAt) : fmtMs(r.durationMs)) },
    { title: 'tok/s', width: 70, align: 'right', render: (_, r) => (r.running ? fmtTps(r.tokensPerSec) : fmtTps(r.tps)) },
    { title: 'Cost', width: 84, align: 'right', render: (_, r) => (r.running ? '…' : fmtUsd(r.cost)) },
    ...(onOpen
      ? [{ title: '', width: 60, render: (_: unknown, r: Row) => (r.running ? null : <a onClick={() => onOpen(r)}>Details</a>) }]
      : []),
  ];
}

export function RequestTable(props: {
  rows: Row[];
  loading?: boolean;
  warnTokens: number;
  onOpen?: (r: HistoryRow) => void;
  compact?: boolean;
}) {
  return (
    <Table<Row>
      rowKey="id"
      size={props.compact ? 'small' : 'middle'}
      loading={props.loading}
      columns={requestColumns(props.warnTokens, props.onOpen)}
      dataSource={props.rows}
      pagination={false}
      scroll={{ x: 980 }}
    />
  );
}
````

### `src/web/src/pages/History.tsx` — NEW file

````tsx
import { ReloadOutlined } from '@ant-design/icons';
import { Alert, Button, Descriptions, Drawer, Input, Segmented, Select, Space, Tag, Typography } from 'antd';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, subscribeEta } from '../api';
import { useAppSettings } from '../appSettings';
import { RequestTable, type Row } from '../components/RequestTable';
import { fmtCompact, fmtDateTime, fmtExact, fmtMs, fmtPct, fmtUsd } from '../format';
import type { HistoryResponse, HistoryRow } from '../types';

const PAGE = 50;

/** Persistent request log: survives restarts, includes requests that are still running. */
export default function HistoryPage() {
  const { settings } = useAppSettings();
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const status = (params.get('status') ?? 'all') as 'all' | 'ok' | 'error';
  const alias = params.get('alias') ?? '';
  const [data, setData] = useState<HistoryResponse | null>(null);
  const [extra, setExtra] = useState<HistoryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [aliases, setAliases] = useState<string[]>([]);
  const [open, setOpen] = useState<HistoryRow | null>(null);
  const [search, setSearch] = useState(q);

  const set = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    if (v && v !== 'all') next.set(k, v);
    else next.delete(k);
    setParams(next, { replace: true });
  };

  const load = useCallback(async () => {
    const qs = new URLSearchParams({ limit: String(PAGE) });
    if (q) qs.set('q', q);
    if (status !== 'all') qs.set('status', status);
    if (alias) qs.set('alias', alias);
    try {
      setData(await api<HistoryResponse>(`/admin/requests?${qs}`));
      setExtra([]);
    } finally {
      setLoading(false);
    }
  }, [q, status, alias]);

  useEffect(() => {
    setLoading(true);
    void load();
  }, [load]);

  // Refresh when a request starts or finishes (stream), and every 10s as a safety net.
  useEffect(() => {
    let timer: number | undefined;
    const soon = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void load(), 400);
    };
    const unsub = subscribeEta((ev) => ev.status !== 'running' && soon());
    const poll = window.setInterval(() => void load(), 10_000);
    return () => {
      unsub();
      window.clearInterval(poll);
      window.clearTimeout(timer);
    };
  }, [load]);

  useEffect(() => {
    void api<{ models: { alias: string }[] }>('/admin/models').then((r) => setAliases(r.models.map((m) => m.alias))).catch(() => undefined);
  }, []);

  const more = async () => {
    const all = [...(data?.rows ?? []), ...extra];
    const before = all[all.length - 1]?.endedAt;
    const qs = new URLSearchParams({ limit: String(PAGE), before: String(before) });
    if (q) qs.set('q', q);
    if (status !== 'all') qs.set('status', status);
    if (alias) qs.set('alias', alias);
    const r = await api<HistoryResponse>(`/admin/requests?${qs}`);
    setExtra((e) => [...e, ...r.rows]);
    setData((d) => (d ? { ...d, hasMore: r.hasMore } : d));
  };

  const rows: Row[] = useMemo(
    () => [...(data?.running ?? []).map((r) => ({ ...r, running: true as const })), ...(data?.rows ?? []), ...extra],
    [data, extra],
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 240 }}>
          <Typography.Title level={4} style={{ margin: 0 }}>History</Typography.Title>
          <Typography.Text type="secondary">
            {data ? `${fmtExact(data.total)} requests${q || status !== 'all' || alias ? ' match' : ' stored'}` : 'Loading…'} · kept for {settings['history.retentionDays'] || '∞'} days
          </Typography.Text>
        </div>
        <Input.Search
          allowClear
          style={{ width: 260 }}
          placeholder="Model, provider, session…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onSearch={(v) => set('q', v.trim())}
        />
        <Select
          allowClear
          style={{ width: 150 }}
          placeholder="All models"
          value={alias || undefined}
          onChange={(v) => set('alias', v ?? '')}
          options={aliases.map((a) => ({ value: a, label: a }))}
        />
        <Segmented value={status} onChange={(v) => set('status', String(v))} options={[{ value: 'all', label: 'All' }, { value: 'ok', label: 'OK' }, { value: 'error', label: 'Errors' }]} />
        <Button icon={<ReloadOutlined />} onClick={() => void load()} aria-label="Refresh" />
      </div>

      {!loading && rows.length === 0 && <Alert type="info" showIcon message="No requests yet" description="Point Claude Code at the router and every request shows up here." />}

      <RequestTable rows={rows} loading={loading} warnTokens={settings['context.warnTokens']} onOpen={setOpen} />
      {data?.hasMore && (
        <Button style={{ alignSelf: 'center' }} onClick={() => void more()}>Load more</Button>
      )}

      <Drawer title="Request details" width={480} open={!!open} onClose={() => setOpen(null)}>
        {open && (
          <Descriptions column={1} size="small" bordered>
            <Descriptions.Item label="Request">{open.id}</Descriptions.Item>
            <Descriptions.Item label="Status">{open.status >= 400 ? <Tag color="error">{open.status}</Tag> : <Tag color="success">{open.status}</Tag>}{open.failover && <Tag color="warning">failover used</Tag>}</Descriptions.Item>
            <Descriptions.Item label="Started">{fmtDateTime(open.startedAt)}</Descriptions.Item>
            <Descriptions.Item label="Model">{open.alias} → {open.provider}/{open.model}</Descriptions.Item>
            <Descriptions.Item label="Key">{open.key ?? '—'}</Descriptions.Item>
            <Descriptions.Item label="Session">{open.sessionId ?? '—'}</Descriptions.Item>
            <Descriptions.Item label="Context (prompt)">{fmtExact(open.ctx)} ({fmtCompact(open.ctx)})</Descriptions.Item>
            <Descriptions.Item label="Fresh input">{fmtExact(open.in)}</Descriptions.Item>
            <Descriptions.Item label="Cache read">{fmtExact(open.cacheRead)} ({fmtPct(open.ctx ? (open.cacheRead / open.ctx) * 100 : 0)})</Descriptions.Item>
            <Descriptions.Item label="Cache write">{fmtExact(open.cacheWrite)}</Descriptions.Item>
            <Descriptions.Item label="Output">{fmtExact(open.out)}</Descriptions.Item>
            <Descriptions.Item label="Time to first token">{fmtMs(open.ttftMs)}</Descriptions.Item>
            <Descriptions.Item label="Duration">{fmtMs(open.durationMs)}</Descriptions.Item>
            <Descriptions.Item label="Cost (estimate)">{fmtUsd(open.cost)}</Descriptions.Item>
          </Descriptions>
        )}
      </Drawer>
      <Space />
    </div>
  );
}
````

### Step 2 — Replace this file completely

### `src/web/src/pages/Live.tsx` — REPLACE the whole file

````tsx
/**
 * Live page: real-time monitor for the router, fed by the /admin/events SSE
 * stream and reconciled against GET /admin/eta every few seconds.
 *
 * - Session totals strip (elapsed, requests, avg ms/request, tokens in/out, cost)
 * - Running requests with per-request progress bars and tok/s
 * - Streaming ApexCharts area chart: output tokens/min over the last 15 minutes,
 *   bucketed per 5s from per-event outputTokensSoFar deltas
 * - Recent terminal events (duration, ttft, tok/s, failover)
 *
 * Note: @lobehub/ui@2.24.3 has no dashboard subpath (no StatCard/Surface/
 * PageHeader), so panels use antd Card/Statistic; typography/tags use lobe-ui.
 */
import { Empty, Tag, Text } from '@lobehub/ui';
import { Card, Statistic, Tooltip, theme as antdTheme } from 'antd';
import type { ApexOptions } from 'apexcharts';
import { useEffect, useMemo, useRef, useState } from 'react';
import Chart from 'react-apexcharts';
import { Link } from 'react-router-dom';
import { api, fetchEtaSnapshot, subscribeEta } from '../api';
import { useAppSettings } from '../appSettings';
import { RequestTable, type Row } from '../components/RequestTable';
import { fmtCompact, fmtExact, fmtPct, fmtUsd, fmtWords } from '../format';
import type { EtaEvent, HistoryResponse, Insights, SessionTotals } from '../types';

const BUCKET_MS = 5_000;
const WINDOW_MS = 15 * 60_000;
const RECONCILE_MS = 5_000;

interface Tracked {
  event: EtaEvent;
  /** Date.now() when this event arrived; elapsed ticks locally between events. */
  recvAt: number;
}

type TokenSeries = ApexOptions['series'];

/** mm:ss (minutes zero-padded); switches to h:mm:ss past one hour. */
function fmtClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${String(m).padStart(2, '0')}:${ss}`;
}

function fmtMs(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return '—';
  if (ms >= 10_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.round(ms)} ms`;
}

function fmtInt(n: number): string {
  return Number.isFinite(n) ? n.toLocaleString('en-US') : '—';
}

function fmtTps(tps: number | null | undefined): string {
  if (tps == null || !Number.isFinite(tps)) return '—';
  return `${tps >= 10 ? Math.round(tps) : tps.toFixed(1)}`;
}

function fmtTime(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return '—';
  return new Date(ts).toLocaleTimeString('en-GB', { hour12: false });
}

function pruneBuckets(buckets: Map<number, number>, nowMs: number): void {
  const cutoff = Math.floor(nowMs / BUCKET_MS) * BUCKET_MS - WINDOW_MS;
  for (const b of buckets.keys()) if (b < cutoff) buckets.delete(b);
}

/** Fixed 180-point (15 min / 5s) rolling window; rate extrapolated to tokens/min. */
function buildSeries(buckets: Map<number, number>, nowMs: number): TokenSeries {
  const end = Math.floor(nowMs / BUCKET_MS) * BUCKET_MS;
  const start = end - WINDOW_MS + BUCKET_MS;
  const data: { x: number; y: number }[] = [];
  for (let b = start; b <= end; b += BUCKET_MS) {
    const tokens = buckets.get(b) ?? 0;
    data.push({ x: b, y: Math.round((tokens / (BUCKET_MS / 1000)) * 60) });
  }
  return [{ name: 'tokens/min', data }];
}

export default function LivePage() {
  const { token } = antdTheme.useToken();

  const runningRef = useRef(new Map<string, Tracked>());
  const bucketsRef = useRef(new Map<number, number>());
  const lastTokensRef = useRef(new Map<string, number>());
  const [now, setNow] = useState(() => Date.now());
  const [session, setSession] = useState<{ totals: SessionTotals; recvAt: number } | null>(null);
  const [streamOk, setStreamOk] = useState<boolean | null>(null);
  const [series, setSeries] = useState<TokenSeries>(() => buildSeries(new Map(), Date.now()));
  const { settings } = useAppSettings();
  const [insights, setInsights] = useState<Insights | null>(null);
  const [history, setHistory] = useState<HistoryResponse | null>(null);
  const [peakTps, setPeakTps] = useState(120);

  /**
   * Token throughput: outputTokensSoFar deltas dropped into 5s buckets. First
   * sight of a request only sets the baseline (no spike); terminal events
   * contribute their final delta and then delete the baseline.
   */
  const noteTokens = (requestId: string, soFar: number, at: number, running: boolean): void => {
    const prev = lastTokensRef.current.get(requestId);
    const delta = prev === undefined ? 0 : Math.max(0, soFar - prev);
    if (running) lastTokensRef.current.set(requestId, soFar);
    else lastTokensRef.current.delete(requestId);
    if (delta > 0) {
      const b = Math.floor(at / BUCKET_MS) * BUCKET_MS;
      bucketsRef.current.set(b, (bucketsRef.current.get(b) ?? 0) + delta);
      pruneBuckets(bucketsRef.current, at);
    }
  };

  const applyEvent = (ev: EtaEvent): void => {
    const at = Date.now();
    if (ev.status === 'running') {
      runningRef.current.set(ev.requestId, { event: ev, recvAt: at });
    } else {
      runningRef.current.delete(ev.requestId);
    }
    noteTokens(ev.requestId, ev.outputTokensSoFar, at, ev.status === 'running');
    if (ev.status !== 'running') {
      refreshLater();
    }
    if (ev.tokensPerSec) setPeakTps((p) => Math.max(p, Math.ceil((ev.tokensPerSec as number) / 50) * 50));
    setNow(at);
  };

  // Persistent history + context stats come from the database; refetched shortly after a request ends.
  const refreshTimer = useRef<number | undefined>(undefined);
  const loadPersisted = (): void => {
    void api<HistoryResponse>('/admin/requests?limit=12').then(setHistory).catch(() => undefined);
    void api<Insights>('/admin/insights?range=24h').then(setInsights).catch(() => undefined);
  };
  const refreshLater = (): void => {
    window.clearTimeout(refreshTimer.current);
    refreshTimer.current = window.setTimeout(loadPersisted, 600);
  };

  useEffect(() => {
    const reconcile = (): void => {
      fetchEtaSnapshot()
        .then((snap) => {
          const at = Date.now();
          const live = new Set(snap.running.map((ev) => ev.requestId));
          for (const ev of snap.running) {
            runningRef.current.set(ev.requestId, { event: ev, recvAt: at });
            // Poll deltas keep the chart live when the SSE stream is down
            // (5s granularity instead of the stream's 1s).
            noteTokens(ev.requestId, ev.outputTokensSoFar, at, true);
          }
          for (const id of runningRef.current.keys()) {
            if (!live.has(id)) {
              runningRef.current.delete(id);
              lastTokensRef.current.delete(id);
            }
          }
          if (snap.session) setSession({ totals: snap.session, recvAt: at });
          setStreamOk(true);
          setNow(at);
        })
        .catch(() => setStreamOk(false));
    };

    reconcile();
    loadPersisted();
    const persistedPoll = window.setInterval(loadPersisted, 15_000);
    const poll = window.setInterval(reconcile, RECONCILE_MS);
    const heartbeat = window.setInterval(() => {
      setNow(Date.now());
      setSeries(buildSeries(bucketsRef.current, Date.now()));
    }, 1000);
    const unsub = subscribeEta(applyEvent);
    return () => {
      window.clearInterval(poll);
      window.clearInterval(persistedPoll);
      window.clearTimeout(refreshTimer.current);
      window.clearInterval(heartbeat);
      unsub();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const chartOptions = useMemo<ApexOptions>(() => {
    void token; // re-theme when the mode flips
    return {
      chart: {
        foreColor: token.colorTextSecondary,
        toolbar: { show: false },
        zoom: { enabled: false },
        animations: {
          enabled: true,
          easing: 'linear',
          speed: 300,
          dynamicAnimation: { enabled: true, speed: 300 },
        },
      },
      colors: [token.colorPrimary],
      dataLabels: { enabled: false },
      stroke: { curve: 'smooth', width: 2 },
      fill: { type: 'gradient', gradient: { opacityFrom: 0.3, opacityTo: 0.02 } },
      xaxis: {
        type: 'datetime',
        range: WINDOW_MS,
        axisBorder: { show: false },
        axisTicks: { show: false },
        labels: {
          datetimeUTC: false,
          datetimeFormatter: { year: 'yyyy', month: "MMM 'yy", day: 'dd MMM', hour: 'HH:mm' },
        },
      },
      yaxis: {
        min: 0,
        labels: { formatter: (v: number) => String(Math.round(v)) },
      },
      tooltip: {
        x: { format: 'HH:mm' },
        y: { formatter: (v: number) => `${Math.round(v)} tok/min` },
      },
      grid: { borderColor: token.colorBorderSecondary },
    };
  }, [token]);

  const runningList = [...runningRef.current.values()].sort(
    (a, b) => b.event.startedAt - a.event.startedAt,
  );
  // Speedometer: combined output speed of everything running right now.
  const liveTps = runningList.reduce((sum, t) => sum + (t.event.tokensPerSec ?? 0), 0);

  const gaugeOptions = useMemo<ApexOptions>(
    () => ({
      chart: { sparkline: { enabled: false }, animations: { enabled: true, speed: 350, dynamicAnimation: { enabled: true, speed: 350 } } },
      plotOptions: {
        radialBar: {
          startAngle: -125,
          endAngle: 125,
          hollow: { size: '64%' },
          track: { background: token.colorFillSecondary, strokeWidth: '100%' },
          dataLabels: {
            name: { show: true, offsetY: 24, color: token.colorTextSecondary, fontSize: '12px' },
            value: {
              show: true,
              offsetY: -14,
              color: token.colorText,
              fontSize: '30px',
              fontWeight: 600,
              formatter: () => (liveTps > 0 ? String(Math.round(liveTps)) : '0'),
            },
          },
        },
      },
      labels: [liveTps > 0 ? 'tokens / second' : 'idle'],
      colors: [liveTps > peakTps * 0.66 ? token.colorSuccess : token.colorPrimary],
      stroke: { lineCap: 'round' },
      fill: { type: 'solid' },
    }),
    [token, liveTps, peakTps],
  );

  const sessionElapsed = session ? session.totals.elapsedMs + Math.max(0, now - session.recvAt) : 0;

  const streamLabel =
    streamOk == null ? 'Connecting' : streamOk ? 'Live' : 'Offline';
  const streamDot =
    streamOk == null
      ? token.colorTextQuaternary
      : streamOk
        ? token.colorSuccess
        : token.colorError;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
        <Text strong style={{ fontSize: 18 }}>
          Live
        </Text>
        <Text type="secondary">Real-time request monitor streamed from the router.</Text>
        <span style={{ flex: 1 }} />
        <span
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
          title={
            streamOk == null
              ? 'Connecting to the live stream...'
              : streamOk
                ? 'Live stream connected'
                : 'Live stream unreachable'
          }
        >
          <span
            aria-hidden
            style={{ width: 8, height: 8, borderRadius: '50%', background: streamDot }}
          />
          <Text type="secondary" fontSize={12}>
            {streamLabel}
          </Text>
        </span>
      </div>

      {insights && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 12 }}>
          <Card size="small">
            <Statistic title="Requests (24 h)" value={fmtCompact(insights.totals.requests)} />
            <Text type="secondary" fontSize={12}>{insights.totals.errors ? `${fmtExact(insights.totals.errors)} failed` : 'no failures'}</Text>
          </Card>
          <Card size="small">
            <Tooltip title={`${fmtExact(insights.totals.input)} tokens (${fmtWords(insights.totals.input)}) = ${fmtExact(insights.totals.fresh)} fresh + ${fmtExact(insights.totals.cacheRead)} from cache`}>
              <div>
                <Statistic title="Prompt tokens sent (24 h)" value={fmtCompact(insights.totals.input)} />
                <Text type="secondary" fontSize={12}>{fmtPct(insights.totals.cacheHitPct, 0)} from cache · {fmtCompact(insights.totals.fresh)} fresh</Text>
              </div>
            </Tooltip>
          </Card>
          <Card size="small">
            <Tooltip title={`${fmtExact(insights.totals.out)} tokens (${fmtWords(insights.totals.out)})`}>
              <div>
                <Statistic title="Output tokens (24 h)" value={fmtCompact(insights.totals.out)} />
                <Text type="secondary" fontSize={12}>generated by the model</Text>
              </div>
            </Tooltip>
          </Card>
          <Card size="small">
            <Statistic title="Cost estimate (24 h)" value={fmtUsd(insights.totals.cost)} />
            <Text type="secondary" fontSize={12}>{insights.totals.cost === 0 ? 'set prices in Settings > Pricing' : 'from model prices'}</Text>
          </Card>
        </div>
      )}

      {session && (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
            gap: 12,
          }}
        >
          <Card size="small">
            <Statistic
              title="Elapsed"
              value={fmtClock(sessionElapsed)}
              suffix={
                session.totals.startedAt > 0 ? (
                  <Text type="secondary" fontSize={12}>
                    since {fmtTime(session.totals.startedAt)}
                  </Text>
                ) : undefined
              }
            />
          </Card>
          <Card size="small">
            <Statistic title="Session requests" value={fmtInt(session.totals.requests)} />
          </Card>
          <Card size="small">
            <Statistic title="Avg ms / request" value={fmtMs(session.totals.avgMsPerRequest)} />
          </Card>
          <Card size="small">
            <Tooltip title={`${fmtExact(session.totals.tokensIn)} tokens (${fmtWords(session.totals.tokensIn)}). Counts the whole prompt of every request, cached part included.`}>
              <div>
                <Statistic title="Session prompt tokens" value={fmtCompact(session.totals.tokensIn)} />
                <Text type="secondary" fontSize={12}>this session</Text>
              </div>
            </Tooltip>
          </Card>
          <Card size="small">
            <Tooltip title={`${fmtExact(session.totals.tokensOut)} tokens (${fmtWords(session.totals.tokensOut)}) generated by the model`}>
              <div>
                <Statistic title="Session output" value={fmtCompact(session.totals.tokensOut)} />
                <Text type="secondary" fontSize={12}>this session</Text>
              </div>
            </Tooltip>
          </Card>
          <Card size="small">
            <Tooltip title="Estimated from the prices set on each model. Set prices in Models if this shows $0.">
              <div>
                <Statistic title="Session cost" value={fmtUsd(session.totals.cost)} />
                <Text type="secondary" fontSize={12}>estimate</Text>
              </div>
            </Tooltip>
          </Card>
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(260px, 320px) minmax(0, 1fr)', gap: 16 }}>
        <Card size="small" title="Speed" extra={<Text type="secondary" fontSize={12}>{runningList.length ? `${runningList.length} running` : 'idle'}</Text>}>
          <Chart options={gaugeOptions} series={[Math.min(100, (liveTps / peakTps) * 100)]} type="radialBar" height={250} />
        </Card>
        <Card size="small" title="Throughput" extra={<Text type="secondary" fontSize={12}>output tokens/min, last 15 min</Text>}>
          <Chart options={chartOptions} series={series} type="area" height={250} />
        </Card>
      </div>

      {insights && insights.totals.requests > 0 && (
        <Card
          size="small"
          title="Context size (last 24 h)"
          extra={<Link to="/usage">More in Usage</Link>}
        >
          <div style={{ display: 'flex', gap: 32, flexWrap: 'wrap', alignItems: 'center' }}>
            <Tooltip title="Half of your requests were smaller than this"><div><Text type="secondary" fontSize={12}>Typical (p50)</Text><div style={{ fontSize: 20, fontWeight: 600 }}>{fmtCompact(insights.context.p50)}</div></div></Tooltip>
            <Tooltip title="9 in 10 requests were smaller than this"><div><Text type="secondary" fontSize={12}>Large (p90)</Text><div style={{ fontSize: 20, fontWeight: 600 }}>{fmtCompact(insights.context.p90)}</div></div></Tooltip>
            <div><Text type="secondary" fontSize={12}>Biggest</Text><div style={{ fontSize: 20, fontWeight: 600 }}>{fmtCompact(insights.context.max)}</div></div>
            <div><Text type="secondary" fontSize={12}>Compactions</Text><div style={{ fontSize: 20, fontWeight: 600 }}>{insights.context.compactions}</div></div>
            <div style={{ flex: 1, minWidth: 240 }}>
              {insights.context.p90 >= settings['context.warnTokens'] ? (
                <Tag color="warning">Large prompts: {fmtPct((insights.context.overWarn / Math.max(1, insights.totals.requests)) * 100, 0)} of requests are over {fmtCompact(settings['context.warnTokens'])}. Run /compact or /clear in Claude Code, or lower /autocompact.</Tag>
              ) : (
                <Tag color="success">Prompts stay under {fmtCompact(settings['context.warnTokens'])}: good.</Tag>
              )}
            </div>
          </div>
        </Card>
      )}

      <Card
        size="small"
        title="Running requests"
        extra={
          runningList.length > 0 ? (
            <Tag color="processing" size="small">
              {runningList.length}
            </Tag>
          ) : undefined
        }
      >
        {runningList.length === 0 ? (
          <Empty
            title="No requests running"
            description="Requests appear here in real time while the router streams them."
          />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {runningList.map((tracked) => (
              <RunningRow key={tracked.event.requestId} tracked={tracked} now={now} />
            ))}
          </div>
        )}
      </Card>

      <Card size="small" title="Recent requests" extra={<Link to="/history">Open full history</Link>}>
        <RequestTable
          compact
          warnTokens={settings['context.warnTokens']}
          rows={[
            ...(history?.running ?? []).map((r) => ({ ...r, running: true as const })),
            ...(history?.rows ?? []),
          ] as Row[]}
        />
      </Card>
    </div>
  );
}

function RunningRow({ tracked, now }: { tracked: Tracked; now: number }) {
  const { token } = antdTheme.useToken();
  const ev = tracked.event;
  const elapsed = ev.elapsedMs + Math.max(0, now - tracked.recvAt);
  const eta = ev.etaMs;
  const pct =
    eta != null && eta > 0 ? Math.min(100, Math.max(2, (elapsed / (elapsed + eta)) * 100)) : null;

  return (
    <div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          flexWrap: 'wrap',
          marginBottom: 6,
        }}
      >
        <Text strong fontSize={13}>
          {ev.alias}
        </Text>
        <Text type="secondary" fontSize={12}>
          {ev.provider} · {ev.model}
        </Text>
        {ev.failover && (
          <Tag color="warning" size="small">
            failover
          </Tag>
        )}
        <span style={{ flex: 1 }} />
        <Text type="secondary" fontSize={12} style={{ fontVariantNumeric: 'tabular-nums' }}>
          {fmtClock(elapsed)}
          {eta != null ? ` · ~${fmtClock(eta)} left` : ' · ~estimating...'}
          {ev.tokensPerSec != null ? ` · ${fmtTps(ev.tokensPerSec)} tok/s` : ''}
          {` · ${fmtInt(ev.outputTokensSoFar)} out`}
        </Text>
      </div>
      <div
        style={{
          height: 4,
          borderRadius: 2,
          overflow: 'hidden',
          background: token.colorFillSecondary,
        }}
      >
        <div
          style={{
            height: '100%',
            width: pct == null ? '35%' : `${pct}%`,
            opacity: pct == null ? 0.45 : 1,
            background: token.colorPrimary,
            transition: 'width 0.6s linear',
          }}
        />
      </div>
    </div>
  );
}
````

### Step 3 — Apply this diff

### `src/web/src/pages/Usage.tsx` — consistent token numbers + prompt-size panel

````diff
--- a/src/web/src/pages/Usage.tsx
+++ b/src/web/src/pages/Usage.tsx
@@ -33,9 +33,12 @@
 } from 'antd';
 import type { ColumnsType } from 'antd/es/table';
 import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
-import { fetchSnapshot, fetchUsageSummary, subscribeEta } from '../api';
+import { api, fetchSnapshot, fetchUsageSummary, subscribeEta } from '../api';
+import { useAppSettings } from '../appSettings';
+import { fmtCompact, fmtExact, fmtPct, fmtUsd as fmtUsdShared } from '../format';
 import { useThemeMode } from '../theme';
 import type {
+  Insights,
   DailyUsage,
   SessionTotals,
   UsageByNameRow,
@@ -77,10 +80,8 @@
 // ---------- Formatting ----------
 
 const fmtInt = (n: number) => n.toLocaleString('en-US');
-const fmtTokens = (n: number) =>
-  n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : fmtInt(n);
-const fmtCompact = (n: number) => (n >= 1e3 ? `${(n / 1e3).toFixed(n % 1e3 === 0 ? 0 : 1)}k` : String(Math.round(n)));
-const fmtUsd = (n: number) => (n === 0 ? '$0.00' : n >= 100 ? `$${n.toFixed(2)}` : `$${n.toFixed(4)}`);
+const fmtTokens = (n: number) => fmtCompact(n);
+const fmtUsd = (n: number) => fmtUsdShared(n);
 const fmtMs = (n: number) => (n >= 10_000 ? `${(n / 1e3).toFixed(1)}s` : `${Math.round(n)}ms`);
 const fmtAgo = (ts: number, now: number) => {
   const s = Math.max(0, Math.round((now - ts) / 1e3));
@@ -175,6 +176,15 @@
   const { token } = theme.useToken();
 
   const [range, setRange] = useState<UsageRange>('24h');
+  const { settings } = useAppSettings();
+  const [insights, setInsights] = useState<Insights | null>(null);
+  useEffect(() => {
+    let dead = false;
+    void api<Insights>(`/admin/insights?range=${range}`).then((r) => !dead && setInsights(r)).catch(() => undefined);
+    return () => {
+      dead = true;
+    };
+  }, [range]);
   const [summary, setSummary] = useState<SummaryEx | null>(null);
   const [loading, setLoading] = useState(true);
   const [error, setError] = useState<string | null>(null);
@@ -676,12 +686,16 @@
               <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 12 }}>
                 <StatTile label="Requests" value={fmtInt(view.requests)} hint={summary.bucketLabel ?? range} />
                 <StatTile
-                  label="Tokens in"
-                  value={fmtTokens(view.tokensIn)}
-                  hint={view.cacheRead ? `${fmtTokens(view.cacheRead)} cache read` : undefined}
+                  label="Prompt tokens sent"
+                  value={
+                    <Tooltip title={`${fmtExact(view.tokensIn + view.cacheRead)} tokens = ${fmtExact(view.tokensIn)} fresh + ${fmtExact(view.cacheRead)} read from cache`}>
+                      <span>{fmtTokens(view.tokensIn + view.cacheRead)}</span>
+                    </Tooltip>
+                  }
+                  hint={`${fmtTokens(view.tokensIn)} fresh · ${fmtTokens(view.cacheRead)} cached`}
                 />
-                <StatTile label="Tokens out" value={fmtTokens(view.tokensOut)} />
-                <StatTile label="Cost" value={fmtUsd(view.cost)} hint="estimated USD" />
+                <StatTile label="Output tokens" value={fmtTokens(view.tokensOut)} hint="generated by the model" />
+                <StatTile label="Cost" value={fmtUsd(view.cost)} hint={view.cost === 0 ? 'no prices set: Settings > Pricing' : 'estimated USD'} />
                 <StatTile label="Avg response" value={view.requests ? fmtMs(view.avgMs) : '—'} hint="per request" />
                 <StatTile
                   label="Avg throughput"
@@ -696,6 +710,42 @@
                 <StatTile label="Running now" value={fmtInt(runningCount)} hint="in-flight requests (live)" />
               </div>
 
+              {insights && insights.totals.requests > 0 ? (
+                <Panel
+                  title="Prompt size: where your tokens go"
+                  caption="Every request re-sends the whole conversation. A smaller prompt is the biggest saving. Numbers come from the request history."
+                >
+                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12 }}>
+                    <StatTile label="Average prompt" value={fmtCompact(insights.context.avg)} hint="per request" />
+                    <StatTile label="Typical (p50)" value={fmtCompact(insights.context.p50)} hint="half are smaller" />
+                    <StatTile label="Large (p90)" value={fmtCompact(insights.context.p90)} hint="9 in 10 are smaller" />
+                    <StatTile label="Biggest" value={fmtCompact(insights.context.max)} />
+                    <StatTile label="Served from cache" value={fmtPct(insights.totals.cacheHitPct)} hint="cheap input" />
+                    <StatTile label="Compactions" value={String(insights.context.compactions)} hint="context shrank" />
+                  </div>
+                  <Typography.Paragraph type="secondary" style={{ marginBottom: 0, marginTop: 12 }}>
+                    {insights.context.p90 >= settings['context.warnTokens']
+                      ? `${fmtPct((insights.context.overWarn / Math.max(1, insights.totals.requests)) * 100, 0)} of requests are over ${fmtCompact(settings['context.warnTokens'])}. Compact earlier (see Settings > Claude Code) and use /clear between tasks.`
+                      : `Prompts stay under ${fmtCompact(settings['context.warnTokens'])}.`}
+                  </Typography.Paragraph>
+                  {insights.topSessions.length > 0 && (
+                    <Table
+                      style={{ marginTop: 12 }}
+                      size="small"
+                      pagination={false}
+                      rowKey="sessionId"
+                      dataSource={insights.topSessions}
+                      columns={[
+                        { title: 'Session', dataIndex: 'sessionId', render: (v: string) => <code>{v}</code> },
+                        { title: 'Requests', dataIndex: 'requests', align: 'right' as const, render: (v: number) => fmtInt(v) },
+                        { title: 'Prompt tokens sent', dataIndex: 'ctxTotal', align: 'right' as const, render: (v: number) => <Tooltip title={fmtExact(v)}>{fmtCompact(v)}</Tooltip> },
+                        { title: 'Biggest prompt', dataIndex: 'maxCtx', align: 'right' as const, render: (v: number) => fmtCompact(v) },
+                      ]}
+                    />
+                  )}
+                </Panel>
+              ) : null}
+
               {stackChart && stackedOptions ? (
                 <Panel title="Daily requests by provider" caption="Stacked volume per day in the selected range">
                   <Chart
````

## Verify

Run the checks after step 04 (this step imports `Settings` routes from it). If you want an early check: `cd src/web && npx tsc --noEmit` — the only acceptable errors at this point mention `Settings`.
