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
            <Descriptions.Item label="Client asked for">{open.requestedModel ?? '—'}{open.resolvedVia ? ` (${open.resolvedVia === 'exact' ? 'exact alias' : open.resolvedVia === 'alias' ? 'matched by the opus/sonnet/haiku map' : 'unknown name, sent to the default model'})` : ''}</Descriptions.Item>
            <Descriptions.Item label="Router chose">{open.askedAlias ?? '—'}</Descriptions.Item>
            <Descriptions.Item label="Answered by">{open.alias} → {open.provider}/{open.model}</Descriptions.Item>
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
        {open && open.trace.length > 0 && (
          <div style={{ marginTop: 16 }}>
            <Typography.Text strong>Route taken</Typography.Text>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
              {open.trace.map((t, i) => (
                <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
                  <Tag color={t.outcome === 'served' ? 'success' : t.outcome === 'retry' ? 'processing' : t.outcome === 'failed' ? 'error' : 'warning'} style={{ margin: 0 }}>{t.outcome}</Tag>
                  <span>
                    <b>{t.route}</b>{t.key ? ` · ${t.key}` : ''}
                    {t.detail ? <Typography.Text type="secondary"> — {t.detail}</Typography.Text> : null}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </Drawer>
      <Space />
    </div>
  );
}
