import { Tooltip, Typography } from 'antd';
import { fmtCompact, fmtExact, fmtPct } from '../format';

const PARTS: { key: string; label: string; color: string }[] = [
  { key: 'toolResult', label: 'Tool results (files read, searches, logs)', color: '#6F94FF' },
  { key: 'system', label: 'System prompt', color: '#E0A344' },
  { key: 'tools', label: 'Tool definitions', color: '#43B58C' },
  { key: 'toolUse', label: 'Tool calls (what the AI asked for)', color: '#B07CFF' },
  { key: 'assistantText', label: 'AI text', color: '#4FB3D9' },
  { key: 'userText', label: 'Your messages', color: '#E5675F' },
  { key: 'thinking', label: 'Thinking', color: '#8A93A3' },
  { key: 'images', label: 'Images', color: '#D9A8C4' },
];

/** One stacked bar + legend: where the tokens of a prompt come from. */
export default function Anatomy({ data }: { data: Record<string, number> | null | undefined }) {
  if (!data) return <Typography.Text type="secondary">Not recorded for this request.</Typography.Text>;
  const total = PARTS.reduce((n, p) => n + (data[p.key] ?? 0), 0);
  if (total <= 0) return null;
  const rows = PARTS.map((p) => ({ ...p, value: data[p.key] ?? 0 })).filter((r) => r.value > 0).sort((a, b) => b.value - a.value);
  return (
    <div>
      <div style={{ display: 'flex', height: 14, borderRadius: 7, overflow: 'hidden', marginBottom: 10 }}>
        {rows.map((r) => (
          <Tooltip key={r.key} title={`${r.label}: ${fmtExact(r.value)} tokens (${fmtPct((r.value / total) * 100)})`}>
            <div style={{ width: `${(r.value / total) * 100}%`, background: r.color }} />
          </Tooltip>
        ))}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: '4px 16px' }}>
        {rows.map((r) => (
          <div key={r.key} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
            <span style={{ width: 10, height: 10, borderRadius: 2, background: r.color, flex: 'none' }} />
            <span style={{ flex: 1 }}>{r.label}</span>
            <span style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtCompact(r.value)}</span>
            <Typography.Text type="secondary" style={{ width: 44, textAlign: 'right' }}>{fmtPct((r.value / total) * 100, 0)}</Typography.Text>
          </div>
        ))}
      </div>
    </div>
  );
}