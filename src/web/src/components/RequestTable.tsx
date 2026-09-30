import { Table, Tag, Tooltip, Typography } from 'antd';
import type { TableColumnsType } from 'antd';
import { fmtCompact, fmtDateTime, fmtExact, fmtMs, fmtPct, fmtTps, fmtUsd } from '../format';
import type { HistoryRow, RunningRow } from '../types';

/** One sentence: why the model you picked did not answer. */
export function routeExplanation(r: { askedAlias?: string | null; alias: string; trace?: HistoryRow['trace'] }): string {
  const bad = (r.trace ?? []).filter((t) => t.outcome === 'failed' || t.outcome === 'skipped');
  if (!bad.length) return `You asked for ${r.askedAlias}; ${r.alias} answered.`;
  return `You asked for ${r.askedAlias}, but ${r.alias} answered. ${bad.map((t) => `${t.route}${t.key ? ` (${t.key})` : ''}: ${t.detail ?? t.outcome}`).join(' | ')}`;
}

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
          {r.askedAlias && r.askedAlias !== r.alias && (
            <Tooltip title={routeExplanation(r)}>
              <Tag color="error" style={{ marginLeft: 6 }}>asked {r.askedAlias}</Tag>
            </Tooltip>
          )}
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
