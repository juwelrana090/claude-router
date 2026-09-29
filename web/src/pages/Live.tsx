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
import { Card, Statistic, theme as antdTheme } from 'antd';
import type { ApexOptions } from 'apexcharts';
import { useEffect, useMemo, useRef, useState } from 'react';
import Chart from 'react-apexcharts';
import { fetchEtaSnapshot, subscribeEta } from '../api';
import type { EtaEvent, SessionTotals } from '../types';

const BUCKET_MS = 5_000;
const WINDOW_MS = 15 * 60_000;
const TERMINALS_MAX = 30;
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
  const [terminals, setTerminals] = useState<EtaEvent[]>([]);
  const [session, setSession] = useState<{ totals: SessionTotals; recvAt: number } | null>(null);
  const [streamOk, setStreamOk] = useState<boolean | null>(null);
  const [series, setSeries] = useState<TokenSeries>(() => buildSeries(new Map(), Date.now()));

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
      setTerminals((list) => [ev, ...list].slice(0, TERMINALS_MAX));
    }
    setNow(at);
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
    const poll = window.setInterval(reconcile, RECONCILE_MS);
    const heartbeat = window.setInterval(() => {
      setNow(Date.now());
      setSeries(buildSeries(bucketsRef.current, Date.now()));
    }, 1000);
    const unsub = subscribeEta(applyEvent);
    return () => {
      window.clearInterval(poll);
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
            <Statistic title="Requests" value={fmtInt(session.totals.requests)} />
          </Card>
          <Card size="small">
            <Statistic title="Avg ms / request" value={fmtMs(session.totals.avgMsPerRequest)} />
          </Card>
          <Card size="small">
            <Statistic title="Tokens in" value={fmtInt(session.totals.tokensIn)} />
          </Card>
          <Card size="small">
            <Statistic title="Tokens out" value={fmtInt(session.totals.tokensOut)} />
          </Card>
          <Card size="small">
            <Statistic title="Cost" value={`$${session.totals.cost.toFixed(4)}`} />
          </Card>
        </div>
      )}

      <Card size="small" title="Throughput" extra={<Text type="secondary" fontSize={12}>output tokens/min, last 15 min</Text>}>
        <Chart options={chartOptions} series={series} type="area" height={240} />
      </Card>

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

      <Card size="small" title="Recent completions">
        {terminals.length === 0 ? (
          <Empty
            title="Nothing finished yet"
            description="Completed requests show duration, time-to-first-token and throughput here."
          />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {terminals.map((ev) => (
              <TerminalRow key={ev.requestId} ev={ev} />
            ))}
          </div>
        )}
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

function TerminalRow({ ev }: { ev: EtaEvent }) {
  const done = ev.status === 'done';
  const tps =
    ev.tokensPerSec ??
    (ev.durationMs && ev.durationMs > 0 ? ev.outputTokensSoFar / (ev.durationMs / 1000) : null);

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <Text type="secondary" fontSize={12} code>
        {fmtTime(ev.startedAt)}
      </Text>
      <Tag color={done ? 'success' : 'error'} size="small" variant="outlined">
        {done ? 'Done' : 'Failed'}
      </Tag>
      <Text strong fontSize={12}>
        {ev.alias}
      </Text>
      <Text type="secondary" fontSize={12} style={{ fontVariantNumeric: 'tabular-nums' }}>
        {fmtMs(ev.durationMs)} total · ttft {fmtMs(ev.ttftMs)} · {fmtTps(tps)} tok/s ·{' '}
        {fmtInt(ev.outputTokensSoFar)} out
      </Text>
      {ev.failover && (
        <Tag color="warning" size="small" variant="outlined">
          failover
        </Tag>
      )}
    </div>
  );
}
