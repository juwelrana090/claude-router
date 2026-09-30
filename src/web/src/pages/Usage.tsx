/**
 * Usage page: range analytics over GET /admin/usage/summary plus a live
 * per-session view fed by the /admin/events eta stream.
 *
 * Wire notes:
 * - The router's summary payload carries a few fields beyond src/types.ts
 *   (timeline, top, errorRate, cacheRead, bucketLabel, logFile). They are
 *   declared here as optional extensions so the shared contract file stays
 *   untouched.
 * - The server exposes no per-session history endpoint (only the most recent
 *   active session via /admin/snapshot), so sessions are accumulated
 *   client-side: SSE terminal events for background sessions, snapshot
 *   totals (authoritative, includes cost) for the active session.
 */
import Chart from 'react-apexcharts';
import type { ApexOptions } from 'apexcharts';
import {
  Alert,
  Button,
  Card,
  Col,
  Empty,
  Row,
  Segmented,
  Select,
  Space,
  Spin,
  Table,
  Tag,
  Tooltip,
  Typography,
  theme,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, fetchSnapshot, fetchUsageSummary, subscribeEta } from '../api';
import { useAppSettings } from '../appSettings';
import { fmtCompact, fmtExact, fmtPct, fmtUsd as fmtUsdShared } from '../format';
import { useThemeMode } from '../theme';
import type {
  Insights,
  DailyUsage,
  SessionTotals,
  UsageByNameRow,
  UsageRange,
  UsageSummary,
  UsageTotals,
} from '../types';

// ---------- Optional server fields beyond the shared contract ----------

interface TotalsEx extends UsageTotals {
  errorRate?: number;
  cacheHitRatio?: number;
}
interface NameRowEx extends UsageByNameRow {
  provider?: string | null;
  errorRate?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cacheHitRatio?: number;
}
interface TimelinePoint {
  ts: number;
  requests: number;
  in: number;
  out: number;
  cost: number;
}
type SummaryEx = Omit<UsageSummary, 'totals' | 'byAlias' | 'byProvider'> & {
  totals: TotalsEx;
  byAlias: NameRowEx[];
  byProvider: NameRowEx[];
  timeline?: TimelinePoint[];
  bucketLabel?: string;
  logFile?: string;
  corruptLines?: number;
};

// ---------- Formatting ----------

const fmtInt = (n: number) => n.toLocaleString('en-US');
const fmtTokens = (n: number) => fmtCompact(n);
const fmtUsd = (n: number) => fmtUsdShared(n);
const fmtMs = (n: number) => (n >= 10_000 ? `${(n / 1e3).toFixed(1)}s` : `${Math.round(n)}ms`);
const fmtAgo = (ts: number, now: number) => {
  const s = Math.max(0, Math.round((now - ts) / 1e3));
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)}m ago` : `${Math.floor(s / 3600)}h ago`;
};

// Dataviz reference palette (validated for adjacent-pair CVD safety in both
// modes). Slots are assigned to providers by overall request rank and never
// cycled: rank 9+ folds into an "Other" bucket.
const PALETTE: Record<'light' | 'dark', string[]> = {
  light: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'],
  dark: ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'],
};

const RANGES: UsageRange[] = ['1h', '24h', '7d', '30d'];
const isRange = (v: string | number): v is UsageRange => (RANGES as string[]).includes(String(v));

// ---------- Sessions (client-side accumulation) ----------

interface SessionRow {
  sessionId: string;
  requests: number;
  tokensIn: number | null;
  tokensOut: number;
  cost: number | null;
  totalMs: number;
  lastActiveAt: number;
}

// ---------- Small building blocks ----------

function Panel({ title, caption, children }: { title: string; caption?: string; children: ReactNode }) {
  return (
    <Card variant="borderless" style={{ height: '100%' }} styles={{ body: { padding: 16, height: '100%' } }}>
      <Typography.Title level={5} style={{ marginTop: 0, marginBottom: caption ? 2 : 8 }}>
        {title}
      </Typography.Title>
      {caption ? (
        <Typography.Text type="secondary" style={{ display: 'block', fontSize: 12, marginBottom: 8 }}>
          {caption}
        </Typography.Text>
      ) : null}
      {children}
    </Card>
  );
}

function StatTile({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <Card variant="borderless" styles={{ body: { padding: '12px 16px' } }}>
      <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block' }}>
        {label}
      </Typography.Text>
      <div style={{ fontSize: 20, fontWeight: 600, lineHeight: 1.3, marginTop: 2, overflowWrap: 'anywhere' }}>
        {value}
      </div>
      {hint ? (
        <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 2 }}>
          {hint}
        </Typography.Text>
      ) : null}
    </Card>
  );
}

// Horizontal-bar option builder (categories ascending so the largest bar
// renders on top; value formatter rides the numeric x-axis).
function hBarOptions(
  base: ApexOptions,
  categories: string[],
  valueFmt: (n: number) => string,
  color: string,
  token: { colorTextSecondary: string },
): ApexOptions {
  return {
    ...base,
    colors: [color],
    plotOptions: { bar: { horizontal: true, borderRadius: 3, columnWidth: '60%' } },
    xaxis: {
      ...base.xaxis,
      categories,
      labels: { ...base.xaxis?.labels, formatter: (val: string) => valueFmt(Number(val)) },
    },
    yaxis: { labels: { style: { colors: token.colorTextSecondary } } },
  };
}

// ---------- Page ----------

export default function UsagePage() {
  const { mode } = useThemeMode();
  const { token } = theme.useToken();

  const [range, setRange] = useState<UsageRange>('24h');
  const { settings } = useAppSettings();
  const [insights, setInsights] = useState<Insights | null>(null);
  useEffect(() => {
    let dead = false;
    void api<Insights>(`/admin/insights?range=${range}`).then((r) => !dead && setInsights(r)).catch(() => undefined);
    return () => {
      dead = true;
    };
  }, [range]);
  const [summary, setSummary] = useState<SummaryEx | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [providerFilter, setProviderFilter] = useState<string | undefined>(undefined);
  const [aliasFilter, setAliasFilter] = useState<string | undefined>(undefined);
  const [sessionRows, setSessionRows] = useState<SessionRow[]>([]);
  const [activeSession, setActiveSession] = useState<SessionTotals | null>(null);
  const [runningCount, setRunningCount] = useState(0);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const activeSessionIdRef = useRef<string | null>(null);

  const load = useCallback(async (r: UsageRange) => {
    setLoading(true);
    setError(null);
    try {
      setSummary((await fetchUsageSummary(r)) as SummaryEx);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(range);
  }, [load, range]);

  // Periodic summary refresh.
  useEffect(() => {
    const id = window.setInterval(() => void load(range), 60_000);
    return () => window.clearInterval(id);
  }, [load, range]);

  // Live eta stream: in-flight counter + background session accumulation.
  useEffect(() => {
    const sessions = new Map<string, SessionRow>();
    const running = new Map<string, number>();
    let flushTimer: number | undefined;

    const flush = () => {
      flushTimer = undefined;
      const cutoff = Date.now() - 20_000; // a running request silent for 20s is gone
      for (const [id, ts] of running) if (ts < cutoff) running.delete(id);
      setRunningCount(running.size);
      setSessionRows([...sessions.values()].sort((a, b) => b.lastActiveAt - a.lastActiveAt));
    };
    const schedule = () => {
      if (flushTimer === undefined) flushTimer = window.setTimeout(flush, 400);
    };

    const unsubscribe = subscribeEta((ev) => {
      const now = Date.now();
      running.set(ev.requestId, now);
      if (ev.status !== 'running') running.delete(ev.requestId);

      // The active session is refreshed (with cost) from /admin/snapshot;
      // counting SSE terminals for it too would double the requests.
      if (ev.sessionId !== activeSessionIdRef.current) {
        let row = sessions.get(ev.sessionId);
        if (!row) {
          row = { sessionId: ev.sessionId, requests: 0, tokensIn: null, tokensOut: 0, cost: null, totalMs: 0, lastActiveAt: now };
          sessions.set(ev.sessionId, row);
        }
        if (ev.status !== 'running') {
          row.requests += 1;
          row.tokensOut += ev.outputTokensSoFar || 0;
          if (typeof ev.durationMs === 'number') row.totalMs += ev.durationMs;
        }
        row.lastActiveAt = Math.max(row.lastActiveAt, ev.startedAt + ev.elapsedMs);
      }
      schedule();
    });

    return () => {
      unsubscribe();
      if (flushTimer !== undefined) window.clearTimeout(flushTimer);
    };
  }, []);

  // Snapshot poll: authoritative totals (incl. cost) for the active session.
  useEffect(() => {
    let stopped = false;
    const poll = async () => {
      try {
        const snap = await fetchSnapshot();
        if (stopped) return;
        setActiveSession(snap.session);
        activeSessionIdRef.current = snap.session?.sessionId ?? null;
        setRunningCount((c) => (c === 0 ? snap.inFlight.length : c));
      } catch {
        // Connection problems surface on the Settings page; keep the last data.
      }
    };
    void poll();
    const id = window.setInterval(() => void poll(), 10_000);
    return () => {
      stopped = true;
      window.clearInterval(id);
    };
  }, []);

  // Keep the "N ago" cells fresh while sessions exist.
  const mergedRows = useMemo<SessionRow[]>(() => {
    const rows = activeSession
      ? [
          {
            sessionId: activeSession.sessionId,
            requests: activeSession.requests,
            tokensIn: activeSession.tokensIn,
            tokensOut: activeSession.tokensOut,
            cost: activeSession.cost,
            totalMs: activeSession.avgMsPerRequest * activeSession.requests,
            lastActiveAt: activeSession.startedAt + activeSession.elapsedMs,
          },
          ...sessionRows.filter((r) => r.sessionId !== activeSession.sessionId),
        ]
      : sessionRows;
    return [...rows].sort((a, b) => b.lastActiveAt - a.lastActiveAt);
  }, [activeSession, sessionRows]);

  useEffect(() => {
    if (!mergedRows.length) return;
    setNowMs(Date.now());
    const id = window.setInterval(() => setNowMs(Date.now()), 5_000);
    return () => window.clearInterval(id);
  }, [mergedRows.length]);

  // ---------- Derived, filter-aware data ----------

  const filteredByProvider = useMemo(
    () => (summary?.byProvider ?? []).filter((r) => !providerFilter || r.name === providerFilter),
    [summary, providerFilter],
  );
  const filteredByAlias = useMemo(
    () =>
      (summary?.byAlias ?? []).filter(
        (r) => (!aliasFilter || r.name === aliasFilter) && (!providerFilter || r.provider === providerFilter),
      ),
    [summary, aliasFilter, providerFilter],
  );
  const filteredDaily = useMemo(
    () =>
      (summary?.daily ?? []).filter(
        (r) => (!providerFilter || r.provider === providerFilter) && (!aliasFilter || r.alias === aliasFilter),
      ),
    [summary, aliasFilter, providerFilter],
  );

  const view = useMemo(() => {
    const sum = (f: (r: NameRowEx) => number) => filteredByAlias.reduce((s, r) => s + f(r), 0);
    const requests = sum((r) => r.requests);
    const avgMs = requests ? sum((r) => r.avgMs * r.requests) / requests : 0;
    const avgTps = requests ? sum((r) => r.avgTokensPerSec * r.requests) / requests : 0;
    const fastest =
      [...filteredByProvider].sort((a, b) => b.avgTokensPerSec - a.avgTokensPerSec).find((r) => r.avgTokensPerSec > 0) ??
      null;
    return {
      requests,
      tokensIn: sum((r) => r.in),
      tokensOut: sum((r) => r.out),
      cacheRead: sum((r) => r.cacheRead ?? 0),
      cost: sum((r) => r.cost),
      avgMs,
      avgTps,
      fastest,
    };
  }, [filteredByAlias, filteredByProvider]);

  const providerOptions = useMemo(() => {
    const names = new Set<string>();
    summary?.byProvider.forEach((r) => names.add(r.name));
    summary?.daily.forEach((r) => names.add(r.provider));
    return [...names].sort().map((n) => ({ value: n, label: n }));
  }, [summary]);
  const aliasOptions = useMemo(
    () => (summary?.byAlias ?? []).map((r) => ({ value: r.name, label: r.name })),
    [summary],
  );

  // ---------- Chart data + options ----------

  const palette = PALETTE[mode];

  const base = useMemo<ApexOptions>(
    () => ({
      chart: {
        background: 'transparent',
        fontFamily: 'inherit',
        foreColor: token.colorTextSecondary,
        toolbar: { show: false },
        zoom: { enabled: false },
      },
      theme: { mode },
      grid: { borderColor: token.colorBorderSecondary, strokeDashArray: 4 },
      tooltip: { theme: mode },
      dataLabels: { enabled: false },
      xaxis: {
        axisBorder: { show: false },
        axisTicks: { color: token.colorBorderSecondary },
        labels: { style: { colors: token.colorTextSecondary } },
      },
      yaxis: { labels: { style: { colors: token.colorTextSecondary } } },
      legend: { show: false, labels: { colors: token.colorTextSecondary } },
    }),
    [mode, token],
  );

  // Stable provider -> color assignment from the unfiltered ranking, so
  // filtering never repaints surviving series.
  const providerSlot = useMemo(() => {
    const totals = new Map<string, number>();
    summary?.daily.forEach((r) => totals.set(r.provider, (totals.get(r.provider) ?? 0) + r.requests));
    const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([n]) => n);
    const map = new Map<string, string>();
    ranked.slice(0, PALETTE.light.length).forEach((name, i) => map.set(name, palette[i]));
    return map;
  }, [summary, palette]);

  const stackChart = useMemo(() => {
    const rows = filteredDaily;
    if (!rows.length) return null;
    const days = [...new Set(rows.map((r) => r.day))].sort();
    const reqFor = (day: string, pred: (r: DailyUsage) => boolean) =>
      rows.filter((r) => r.day === day && pred(r)).reduce((s, r) => s + r.requests, 0);

    const series: { name: string; color: string; data: number[] }[] = [];
    for (const [provider, color] of providerSlot) {
      const data = days.map((d) => reqFor(d, (r) => r.provider === provider));
      if (data.some((v) => v > 0)) series.push({ name: provider, color, data });
    }
    const colors = series.map((s) => s.color);
    if (rows.some((r) => !providerSlot.has(r.provider))) {
      const otherCount = new Set(rows.filter((r) => !providerSlot.has(r.provider)).map((r) => r.provider)).size;
      series.push({
        name: `Other (${otherCount})`,
        color: token.colorTextQuaternary,
        data: days.map((d) => reqFor(d, (r) => !providerSlot.has(r.provider))),
      });
      colors.push(token.colorTextQuaternary);
    }
    return {
      categories: days,
      series: series.map(({ name, data }) => ({ name, data })),
      colors,
    };
  }, [filteredDaily, providerSlot, token]);

  const stackedOptions = useMemo<ApexOptions | null>(() => {
    if (!stackChart) return null;
    return {
      ...base,
      colors: stackChart.colors,
      chart: { ...base.chart, stacked: true },
      stroke: { show: true, width: 2, colors: [token.colorBgContainer] },
      plotOptions: { bar: { columnWidth: '60%', borderRadius: 3 } },
      legend: { ...base.legend, show: true, position: 'top', horizontalAlign: 'left' },
      xaxis: {
        ...base.xaxis,
        categories: stackChart.categories,
        labels: {
          ...base.xaxis?.labels,
          rotate: stackChart.categories.length > 16 ? -45 : 0,
          formatter: (value: string) => (value.length >= 10 ? value.slice(5) : value),
        },
      },
      yaxis: { labels: { style: { colors: token.colorTextSecondary }, formatter: (val: number) => fmtCompact(val) } },
      tooltip: { ...base.tooltip, y: { formatter: (val: number) => `${fmtInt(val)} req` } },
    };
  }, [base, stackChart, token]);

  const timelinePoints = summary?.timeline ?? [];
  const costOptions = useMemo<ApexOptions>(
    () => ({
      ...base,
      colors: [palette[0]],
      stroke: { show: true, width: 2, curve: 'straight' },
      markers: { size: 0 },
      xaxis: {
        ...base.xaxis,
        type: 'datetime',
        labels: { ...base.xaxis?.labels, datetimeUTC: false },
      },
      yaxis: { labels: { style: { colors: token.colorTextSecondary }, formatter: (val: number) => fmtUsd(val) } },
      tooltip: {
        ...base.tooltip,
        x: { formatter: (val: number) => new Date(Number(val)).toLocaleString() },
        y: { formatter: (val: number) => fmtUsd(val) },
      },
    }),
    [base, palette, token],
  );

  // Horizontal bars: ascending arrays so the largest bar renders on top.
  const provRequests = useMemo(() => {
    const rows = [...filteredByProvider].sort((a, b) => a.requests - b.requests);
    return { categories: rows.map((r) => r.name), series: [{ name: 'Requests', data: rows.map((r) => r.requests) }] };
  }, [filteredByProvider]);
  const provAvgMs = useMemo(() => {
    const rows = [...filteredByProvider].sort((a, b) => a.avgMs - b.avgMs);
    return { categories: rows.map((r) => r.name), series: [{ name: 'Avg ms', data: rows.map((r) => r.avgMs) }] };
  }, [filteredByProvider]);
  const aliasCost = useMemo(() => {
    const rows = [...filteredByAlias].sort((a, b) => a.cost - b.cost).slice(-10);
    return {
      categories: rows.map((r) => r.name),
      series: [{ name: 'Cost', data: rows.map((r) => Math.round(r.cost * 1e4) / 1e4) }],
    };
  }, [filteredByAlias]);

  const provReqOptions = useMemo(
    () => hBarOptions(base, provRequests.categories, fmtCompact, palette[0], token),
    [base, palette, provRequests, token],
  );
  const provMsOptions = useMemo(
    () => hBarOptions(base, provAvgMs.categories, fmtMs, palette[1], token),
    [base, palette, provAvgMs, token],
  );
  const aliasCostOptions = useMemo(
    () => hBarOptions(base, aliasCost.categories, fmtUsd, palette[0], token),
    [base, palette, aliasCost, token],
  );

  // ---------- CSV export (summary-derived; the router has no raw-rows endpoint) ----------

  const exportCsv = useCallback(() => {
    if (!summary) return;
    const esc = (v: unknown) => {
      const s = v == null ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const header = [
      'alias',
      'provider',
      'requests',
      'tokens_in',
      'tokens_out',
      'cache_read',
      'cache_write',
      'cost_usd',
      'avg_ms',
      'avg_tokens_per_sec',
    ];
    const lines = [header.join(',')];
    lines.push(
      [
        'TOTAL',
        providerFilter ?? '',
        view.requests,
        view.tokensIn,
        view.tokensOut,
        view.cacheRead,
        summary.totals.cacheWrite ?? '',
        view.cost,
        Math.round(view.avgMs),
        view.avgTps.toFixed(1),
      ]
        .map(esc)
        .join(','),
    );
    for (const r of filteredByAlias) {
      lines.push(
        [r.name, r.provider ?? '', r.requests, r.in, r.out, r.cacheRead ?? '', r.cacheWrite ?? '', r.cost, r.avgMs, r.avgTokensPerSec]
          .map(esc)
          .join(','),
      );
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `claude-router-usage-${range}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }, [summary, providerFilter, view, filteredByAlias, range]);

  // ---------- Tables ----------

  const sessionColumns: ColumnsType<SessionRow> = [
    {
      title: 'Session',
      dataIndex: 'sessionId',
      render: (v: string) => (
        <Tooltip title={v}>
          <code>{v.length > 12 ? `${v.slice(0, 12)}…` : v}</code>
        </Tooltip>
      ),
    },
    {
      title: 'Status',
      render: (_, r) =>
        nowMs - r.lastActiveAt < 60_000 ? <Tag color="green">active</Tag> : <Tag>idle</Tag>,
    },
    { title: 'Last activity', render: (_, r) => fmtAgo(r.lastActiveAt, nowMs) },
    { title: 'Requests', dataIndex: 'requests', align: 'right', render: (v: number) => fmtInt(v) },
    {
      title: 'Tokens in',
      dataIndex: 'tokensIn',
      align: 'right',
      render: (v: number | null) => (v == null ? '—' : fmtTokens(v)),
    },
    { title: 'Tokens out', dataIndex: 'tokensOut', align: 'right', render: (v: number) => fmtTokens(v) },
    {
      title: 'Cost',
      dataIndex: 'cost',
      align: 'right',
      render: (v: number | null) => (v == null ? '—' : fmtUsd(v)),
    },
    {
      title: 'Avg duration',
      align: 'right',
      render: (_, r) => (r.requests ? fmtMs(r.totalMs / r.requests) : '—'),
    },
  ];

  const aliasColumns: ColumnsType<NameRowEx> = [
    { title: 'Alias', dataIndex: 'name' },
    { title: 'Provider', render: (_, r) => r.provider ?? '—' },
    { title: 'Requests', dataIndex: 'requests', align: 'right', render: (v: number) => fmtInt(v) },
    { title: 'Tokens in', dataIndex: 'in', align: 'right', render: (v: number) => fmtTokens(v) },
    { title: 'Tokens out', dataIndex: 'out', align: 'right', render: (v: number) => fmtTokens(v) },
    { title: 'Cost', dataIndex: 'cost', align: 'right', render: (v: number) => fmtUsd(v) },
    { title: 'Avg ms', dataIndex: 'avgMs', align: 'right', render: (v: number) => fmtMs(v) },
    { title: 'tok/s', dataIndex: 'avgTokensPerSec', align: 'right', render: (v: number) => v.toFixed(1) },
  ];

  const providerColumns: ColumnsType<NameRowEx> = [
    { title: 'Provider', dataIndex: 'name' },
    { title: 'Requests', dataIndex: 'requests', align: 'right', render: (v: number) => fmtInt(v) },
    { title: 'Tokens in', dataIndex: 'in', align: 'right', render: (v: number) => fmtTokens(v) },
    { title: 'Tokens out', dataIndex: 'out', align: 'right', render: (v: number) => fmtTokens(v) },
    { title: 'Cost', dataIndex: 'cost', align: 'right', render: (v: number) => fmtUsd(v) },
    { title: 'Avg ms', dataIndex: 'avgMs', align: 'right', render: (v: number) => fmtMs(v) },
    { title: 'tok/s', dataIndex: 'avgTokensPerSec', align: 'right', render: (v: number) => v.toFixed(1) },
  ];

  // ---------- Render ----------

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {error ? (
        <Alert
          type="error"
          showIcon
          message="Failed to load usage summary"
          description={error}
          action={
            <Button size="small" onClick={() => void load(range)}>
              Retry
            </Button>
          }
        />
      ) : null}

      <Space wrap>
        <Segmented
          options={RANGES}
          value={range}
          onChange={(v) => {
            if (isRange(v)) setRange(v);
          }}
        />
        <Select
          placeholder="All providers"
          allowClear
          value={providerFilter}
          onChange={(v) => setProviderFilter(v ?? undefined)}
          options={providerOptions}
          style={{ minWidth: 170 }}
        />
        <Select
          placeholder="All aliases"
          allowClear
          value={aliasFilter}
          onChange={(v) => setAliasFilter(v ?? undefined)}
          options={aliasOptions}
          style={{ minWidth: 170 }}
        />
        <Button onClick={() => void load(range)}>Refresh</Button>
        <Button type="primary" onClick={exportCsv} disabled={!summary || summary.totals.requests === 0}>
          Export CSV
        </Button>
      </Space>

      <Spin spinning={loading}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {summary && summary.totals.requests === 0 ? (
            <Card variant="borderless" styles={{ body: { padding: 32 } }}>
              <Empty description="No usage recorded for this range yet">
                {summary.logFile ? (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {summary.logFile}
                  </Typography.Text>
                ) : null}
              </Empty>
            </Card>
          ) : summary ? (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 12 }}>
                <StatTile label="Requests" value={fmtInt(view.requests)} hint={summary.bucketLabel ?? range} />
                <StatTile
                  label="Prompt tokens sent"
                  value={
                    <Tooltip title={`${fmtExact(view.tokensIn + view.cacheRead)} tokens = ${fmtExact(view.tokensIn)} fresh + ${fmtExact(view.cacheRead)} read from cache`}>
                      <span>{fmtTokens(view.tokensIn + view.cacheRead)}</span>
                    </Tooltip>
                  }
                  hint={`${fmtTokens(view.tokensIn)} fresh · ${fmtTokens(view.cacheRead)} cached`}
                />
                <StatTile label="Output tokens" value={fmtTokens(view.tokensOut)} hint="generated by the model" />
                <StatTile label="Cost" value={fmtUsd(view.cost)} hint={view.cost === 0 ? 'no prices set: Settings > Pricing' : 'estimated USD'} />
                <StatTile label="Avg response" value={view.requests ? fmtMs(view.avgMs) : '—'} hint="per request" />
                <StatTile
                  label="Avg throughput"
                  value={view.avgTps ? `${view.avgTps.toFixed(1)} tok/s` : '—'}
                  hint="output tokens"
                />
                <StatTile
                  label="Fastest provider"
                  value={view.fastest?.name ?? '—'}
                  hint={view.fastest ? `${view.fastest.avgTokensPerSec.toFixed(1)} tok/s avg` : 'no throughput yet'}
                />
                <StatTile label="Running now" value={fmtInt(runningCount)} hint="in-flight requests (live)" />
              </div>

              {insights && insights.totals.requests > 0 ? (
                <Panel
                  title="Prompt size: where your tokens go"
                  caption="Every request re-sends the whole conversation. A smaller prompt is the biggest saving. Numbers come from the request history."
                >
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12 }}>
                    <StatTile label="Average prompt" value={fmtCompact(insights.context.avg)} hint="per request" />
                    <StatTile label="Typical (p50)" value={fmtCompact(insights.context.p50)} hint="half are smaller" />
                    <StatTile label="Large (p90)" value={fmtCompact(insights.context.p90)} hint="9 in 10 are smaller" />
                    <StatTile label="Biggest" value={fmtCompact(insights.context.max)} />
                    <StatTile label="Served from cache" value={fmtPct(insights.totals.cacheHitPct)} hint="cheap input" />
                    <StatTile label="Compactions" value={String(insights.context.compactions)} hint="context shrank" />
                  </div>
                  <Typography.Paragraph type="secondary" style={{ marginBottom: 0, marginTop: 12 }}>
                    {insights.context.p90 >= settings['context.warnTokens']
                      ? `${fmtPct((insights.context.overWarn / Math.max(1, insights.totals.requests)) * 100, 0)} of requests are over ${fmtCompact(settings['context.warnTokens'])}. Compact earlier (see Settings > Claude Code) and use /clear between tasks.`
                      : `Prompts stay under ${fmtCompact(settings['context.warnTokens'])}.`}
                  </Typography.Paragraph>
                  {insights.topSessions.length > 0 && (
                    <Table
                      style={{ marginTop: 12 }}
                      size="small"
                      pagination={false}
                      rowKey="sessionId"
                      dataSource={insights.topSessions}
                      columns={[
                        { title: 'Session', dataIndex: 'sessionId', render: (v: string) => <code>{v}</code> },
                        { title: 'Requests', dataIndex: 'requests', align: 'right' as const, render: (v: number) => fmtInt(v) },
                        { title: 'Prompt tokens sent', dataIndex: 'ctxTotal', align: 'right' as const, render: (v: number) => <Tooltip title={fmtExact(v)}>{fmtCompact(v)}</Tooltip> },
                        { title: 'Biggest prompt', dataIndex: 'maxCtx', align: 'right' as const, render: (v: number) => fmtCompact(v) },
                      ]}
                    />
                  )}
                </Panel>
              ) : null}

              {stackChart && stackedOptions ? (
                <Panel title="Daily requests by provider" caption="Stacked volume per day in the selected range">
                  <Chart
                    options={stackedOptions}
                    series={stackChart.series}
                    type="bar"
                    height={Math.max(260, 80 + stackChart.categories.length * 22)}
                  />
                </Panel>
              ) : null}

              {timelinePoints.length ? (
                <Panel
                  title="Cost over time"
                  caption={`All providers and aliases${providerFilter || aliasFilter ? ' (timeline is not filterable)' : ''}`}
                >
                  <Chart
                    options={costOptions}
                    series={[{ name: 'Cost', data: timelinePoints.map((p) => ({ x: p.ts, y: Math.round(p.cost * 1e4) / 1e4 })) }]}
                    type="line"
                    height={260}
                  />
                </Panel>
              ) : null}

              <Row gutter={[16, 16]}>
                <Col xs={24} lg={12}>
                  <Panel title="Requests by provider">
                    {provRequests.categories.length ? (
                      <Chart options={provReqOptions} series={provRequests.series} type="bar" height={Math.max(220, provRequests.categories.length * 44 + 60)} />
                    ) : (
                      <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} />
                    )}
                  </Panel>
                </Col>
                <Col xs={24} lg={12}>
                  <Panel title="Avg response time by provider">
                    {provAvgMs.categories.length ? (
                      <Chart options={provMsOptions} series={provAvgMs.series} type="bar" height={Math.max(220, provAvgMs.categories.length * 44 + 60)} />
                    ) : (
                      <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} />
                    )}
                  </Panel>
                </Col>
              </Row>

              <Row gutter={[16, 16]}>
                <Col xs={24} lg={12}>
                  <Panel title="Cost by alias" caption="Top 10 in the filtered view">
                    {aliasCost.categories.length ? (
                      <Chart options={aliasCostOptions} series={aliasCost.series} type="bar" height={Math.max(220, aliasCost.categories.length * 40 + 60)} />
                    ) : (
                      <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} />
                    )}
                  </Panel>
                </Col>
                <Col xs={24} lg={12}>
                  <Panel title="Providers" caption="Filtered rollup for the selected range">
                    <Table<NameRowEx>
                      dataSource={filteredByProvider}
                      columns={providerColumns}
                      rowKey="name"
                      size="small"
                      pagination={false}
                      scroll={{ x: 'max-content' }}
                      locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} /> }}
                    />
                  </Panel>
                </Col>
              </Row>

              <Panel title="Aliases" caption="Filtered rollup for the selected range">
                <Table<NameRowEx>
                  dataSource={filteredByAlias}
                  columns={aliasColumns}
                  rowKey="name"
                  size="small"
                  pagination={false}
                  scroll={{ x: 'max-content' }}
                  locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} /> }}
                />
              </Panel>

              <Panel
                title="Sessions"
                caption="Accumulated while this page is open (SSE terminals + the active session from the snapshot). Tokens in and cost come only from the snapshot's active session."
              >
                <Table<SessionRow>
                  dataSource={mergedRows}
                  columns={sessionColumns}
                  rowKey="sessionId"
                  size="small"
                  pagination={mergedRows.length > 10 ? { pageSize: 10, size: 'small' } : false}
                  locale={{ emptyText: 'No sessions observed yet — rows appear as live traffic flows.' }}
                />
              </Panel>

              {summary.corruptLines ? (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {summary.corruptLines} corrupt log line(s) skipped by the server.
                </Typography.Text>
              ) : null}
            </>
          ) : null}
        </div>
      </Spin>
    </div>
  );
}
