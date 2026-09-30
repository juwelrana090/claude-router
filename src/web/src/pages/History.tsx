import { ReloadOutlined } from '@ant-design/icons';
import { Alert, Button, Descriptions, Drawer, Input, Segmented, Select, Tag, Typography } from 'antd';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, subscribeEta } from '../api';
import { useAppSettings } from '../appSettings';
import Anatomy from '../components/Anatomy';
import { RequestTable, type Row } from '../components/RequestTable';
import { fmtCompact, fmtDateTime, fmtExact, fmtMs, fmtPct, fmtUsd } from '../format';
import type { HistoryResponse, HistoryRow } from '../types';

const SIZES = [25, 50, 100, 200];
const DEFAULT_SIZE = 25;

/** Persistent request log with real pages. Page, page size and filters live in the URL, so a refresh or a shared link lands on the same rows. */
export default function HistoryPage() {
  const { settings } = useAppSettings();
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const status = (params.get('status') ?? 'all') as 'all' | 'ok' | 'error';
  const alias = params.get('alias') ?? '';
  const size = SIZES.includes(Number(params.get('size'))) ? Number(params.get('size')) : DEFAULT_SIZE;
  const page = Math.max(1, Math.floor(Number(params.get('page')) || 1));
  const [data, setData] = useState<HistoryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [aliases, setAliases] = useState<string[]>([]);
  const [open, setOpen] = useState<HistoryRow | null>(null);
  const [search, setSearch] = useState(q);

  /** Change URL params. Any filter change goes back to page 1. */
  const patch = (changes: Record<string, string>, keepPage = false) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(changes)) {
      if (v && v !== 'all' && !(k === 'page' && v === '1') && !(k === 'size' && Number(v) === DEFAULT_SIZE)) next.set(k, v);
      else next.delete(k);
    }
    if (!keepPage) next.delete('page');
    setParams(next, { replace: true });
  };

  const load = useCallback(async () => {
    const qs = new URLSearchParams({ limit: String(size), offset: String((page - 1) * size) });
    if (q) qs.set('q', q);
    if (status !== 'all') qs.set('status', status);
    if (alias) qs.set('alias', alias);
    try {
      setData(await api<HistoryResponse>(`/admin/requests?${qs}`));
    } finally {
      setLoading(false);
    }
  }, [q, status, alias, size, page]);

  useEffect(() => {
    setLoading(true);
    void load();
  }, [load]);

  // The newest requests live on page 1, so only page 1 refreshes by itself (a request ending, plus every 10 s).
  // On any other page the rows stay put; use the refresh button.
  useEffect(() => {
    if (page !== 1) return;
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
  }, [load, page]);

  useEffect(() => {
    void api<{ models: { alias: string }[] }>('/admin/models').then((r) => setAliases(r.models.map((m) => m.alias))).catch(() => undefined);
  }, []);

  // Deleted history or a narrower filter can leave us past the last page: jump back to it.
  const lastPage = data ? Math.max(1, Math.ceil(data.total / size)) : 1;
  useEffect(() => {
    if (data && page > lastPage) patch({ page: String(lastPage) }, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, lastPage, page]);

  const rows: Row[] = useMemo(
    () => [...(page === 1 ? (data?.running ?? []).map((r) => ({ ...r, running: true as const })) : []), ...(data?.rows ?? [])],
    [data, page],
  );
  const filtered = !!(q || status !== 'all' || alias);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 240 }}>
          <Typography.Title level={4} style={{ margin: 0 }}>History</Typography.Title>
          <Typography.Text type="secondary">
            {data ? `${fmtExact(data.total)} requests${filtered ? ' match' : ' stored'}` : 'Loading…'} · kept for {settings['history.retentionDays'] || '∞'} days
            {page > 1 && <Tag style={{ marginLeft: 8 }}>page {page}: not auto-refreshing</Tag>}
          </Typography.Text>
        </div>
        <Input.Search
          allowClear
          style={{ width: 260 }}
          placeholder="Model, provider, session…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onSearch={(v) => patch({ q: v.trim() })}
        />
        <Select
          allowClear
          style={{ width: 150 }}
          placeholder="All models"
          value={alias || undefined}
          onChange={(v) => patch({ alias: v ?? '' })}
          options={aliases.map((a) => ({ value: a, label: a }))}
        />
        <Segmented value={status} onChange={(v) => patch({ status: String(v) })} options={[{ value: 'all', label: 'All' }, { value: 'ok', label: 'OK' }, { value: 'error', label: 'Errors' }]} />
        <Button icon={<ReloadOutlined />} onClick={() => void load()} aria-label="Refresh" />
      </div>

      {!loading && rows.length === 0 && !filtered && <Alert type="info" showIcon message="No requests yet" description="Point Claude Code at the router and every request shows up here." />}
      {!loading && rows.length === 0 && filtered && <Alert type="info" showIcon message="Nothing matches these filters" />}

      <RequestTable
        rows={rows}
        loading={loading}
        warnTokens={settings['context.warnTokens']}
        onOpen={setOpen}
        pagination={{
          current: page,
          pageSize: size,
          total: data?.total ?? 0,
          showSizeChanger: true,
          pageSizeOptions: SIZES.map(String),
          showQuickJumper: (data?.total ?? 0) > size * 5,
          showTotal: (total, range) => `${fmtExact(range[0])}-${fmtExact(range[1])} of ${fmtExact(total)}`,
          hideOnSinglePage: false,
          position: ['bottomRight'],
          onChange: (p, s) => (s !== size ? patch({ size: String(s), page: '1' }, true) : patch({ page: String(p) }, true)),
        }}
      />

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
            {(open.memorySaved > 0 || open.memoryWould > 0) && (
              <Descriptions.Item label="Router memory">{open.memorySaved > 0 ? `old messages replaced by a stored summary, ~${fmtExact(open.memorySaved)} tokens saved` : `a summary would save ~${fmtExact(open.memoryWould)} tokens`}</Descriptions.Item>
            )}
            {(open.guardSaved > 0 || open.guardWould > 0) && (
              <Descriptions.Item label="Context guard">{open.guardSaved > 0 ? `removed ~${fmtExact(open.guardSaved)} tokens` : `would remove ~${fmtExact(open.guardWould)} tokens`}</Descriptions.Item>
            )}
          </Descriptions>
        )}
        {open && open.anatomy && (
          <div style={{ marginTop: 16 }}>
            <Typography.Text strong>What this prompt was made of</Typography.Text>
            <div style={{ marginTop: 8 }}><Anatomy data={open.anatomy} /></div>
          </div>
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
    </div>
  );
}
