import { CheckCircleFilled, LinkOutlined, PlusOutlined } from '@ant-design/icons';
import { Alert, App, Button, Card, Checkbox, Input, Modal, Segmented, Space, Tag, Tooltip, Typography } from 'antd';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';

interface CatModel { id: string; label: string; coding?: boolean; free?: boolean; price?: { in: number; out: number; cacheRead?: number; peak?: boolean }; note?: string }
interface Entry {
  id: string; name: string; tier: 'local' | 'free' | 'freemium' | 'cheap'; protocol: 'anthropic' | 'openai'; baseURL: string;
  auth: string; keyUrl?: string; pricingUrl?: string; summary: string; limits?: string; privacy?: string; steps: string[];
  models: CatModel[]; customModelHint?: string; suggestedLimits?: { dailyRequests?: number; dailyTokens?: number }; verified: string;
  installed: string | null; addedModels: string[];
}
interface CatalogData { version: string; envVersion: string; entries: Entry[] }

const TIER: Record<Entry['tier'], { label: string; color: string }> = {
  local: { label: 'Free, on your computer', color: 'green' },
  free: { label: 'Free tier', color: 'green' },
  freemium: { label: 'Free start, pay later', color: 'gold' },
  cheap: { label: 'Low price', color: 'blue' },
};
const money = (n: number) => `$${n < 0.1 ? n.toFixed(3).replace(/0+$/, '') : n.toFixed(2)}`;

/** Known providers with the exact address and settings. Pick one, paste a key, choose models: done in one save. */
export default function CatalogPage() {
  const { isAdmin } = useAuth();
  const { message } = App.useApp();
  const [data, setData] = useState<CatalogData | null>(null);
  const [filter, setFilter] = useState<'all' | 'free' | 'cheap'>('all');
  const [adding, setAdding] = useState<Entry | null>(null);
  const [key, setKey] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [custom, setCustom] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => { setData(await api<CatalogData>('/admin/catalog')); }, []);
  useEffect(() => { void load(); }, [load]);

  const list = useMemo(() => (data?.entries ?? []).filter((e) => filter === 'all' || (filter === 'free' ? e.tier !== 'cheap' : e.tier === 'cheap' || e.models.some((m) => m.price))), [data, filter]);

  const open = (e: Entry) => {
    setAdding(e);
    setKey('');
    setCustom('');
    const firstFree = e.models.find((m) => m.free && m.coding) ?? e.models.find((m) => m.coding) ?? e.models[0];
    setPicked(firstFree && !e.addedModels.includes(firstFree.id) ? [firstFree.id] : []);
  };

  const submit = async () => {
    if (!adding || !data) return;
    const models = [...picked, ...(custom.trim() ? [custom.trim()] : [])];
    setBusy(true);
    try {
      const r = await api<{ models: string[]; warning: string | null }>('/admin/catalog/add', {
        method: 'POST',
        body: JSON.stringify({ version: data.version, envVersion: data.envVersion, id: adding.id, key: key.trim() || undefined, models }),
      });
      message.success(`Added ${r.models.join(', ')}`);
      if (r.warning) message.warning(r.warning, 8);
      setAdding(null);
      await load();
    } catch (e) {
      message.error((e as Error).message.replace(/^.*failed: \d+ /, ''), 8);
      await load();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 260 }}>
          <Typography.Title level={4} style={{ margin: 0 }}>Catalog: free and low-price coding AI</Typography.Title>
          <Typography.Text type="secondary">Pick one, paste your key, choose models. The router sets the address, login style and format for you. Free tiers change without notice: each card says when it was checked and where to see the current numbers.</Typography.Text>
        </div>
        <Segmented value={filter} onChange={(v) => setFilter(v as typeof filter)} options={[{ value: 'all', label: 'All' }, { value: 'free', label: 'Free to start' }, { value: 'cheap', label: 'Low price' }]} />
        <Link to="/instructions">How to use free or paid AI</Link>
      </div>
      {!isAdmin && <Alert type="info" showIcon message="Read-only account: ask an admin to add providers." />}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(380px, 1fr))', gap: 16 }}>
        {list.map((e) => (
          <Card
            key={e.id}
            size="small"
            title={<Space>{e.name}{e.installed && <Tooltip title={`Already in your router as “${e.installed}”`}><CheckCircleFilled style={{ color: '#43B58C' }} /></Tooltip>}</Space>}
            extra={<Tag color={TIER[e.tier].color}>{TIER[e.tier].label}</Tag>}
            actions={[
              <Button key="add" type="link" icon={<PlusOutlined />} disabled={!isAdmin} onClick={() => open(e)}>{e.installed ? 'Add more models' : 'Add'}</Button>,
              e.keyUrl ? <a key="key" href={e.keyUrl} target="_blank" rel="noreferrer"><LinkOutlined /> Get a key</a> : <span key="nokey" />,
            ]}
          >
            <Typography.Paragraph style={{ marginBottom: 8 }}>{e.summary}</Typography.Paragraph>
            <Space size={[4, 4]} wrap style={{ marginBottom: 8 }}>
              <Tag>{e.protocol === 'openai' ? 'OpenAI style (converted)' : 'Claude format'}</Tag>
              <Tag style={{ fontFamily: 'monospace' }}>{e.baseURL}</Tag>
            </Space>
            {e.limits && <Typography.Paragraph type="secondary" style={{ fontSize: 13, marginBottom: 6 }}><b>Limits:</b> {e.limits}</Typography.Paragraph>}
            {e.privacy && <Typography.Paragraph type="secondary" style={{ fontSize: 13, marginBottom: 6 }}><b>Privacy:</b> {e.privacy}</Typography.Paragraph>}
            {e.models.length > 0 && (
              <div style={{ fontSize: 13, marginBottom: 6 }}>
                {e.models.slice(0, 6).map((m) => (
                  <div key={m.id} style={{ display: 'flex', gap: 8 }}>
                    <span style={{ flex: 1 }}>{m.label}{m.coding ? ' · coding' : ''}</span>
                    <span style={{ fontVariantNumeric: 'tabular-nums' }}>{m.free ? <Tag color="green" style={{ margin: 0 }}>free</Tag> : m.price ? `${money(m.price.in)} in / ${money(m.price.out)} out` : ''}</span>
                  </div>
                ))}
                {e.models.length > 6 && <Typography.Text type="secondary">+ {e.models.length - 6} more</Typography.Text>}
                {e.models.some((m) => m.price) && <div><Typography.Text type="secondary" style={{ fontSize: 12 }}>USD per million tokens</Typography.Text></div>}
              </div>
            )}
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>Checked: {e.verified}</Typography.Text>
          </Card>
        ))}
      </div>

      <Modal title={adding ? `Add ${adding.name}` : ''} open={!!adding} onCancel={() => setAdding(null)} onOk={() => void submit()} okText="Add" confirmLoading={busy} destroyOnHidden width={620}>
        {adding && (
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <ol style={{ margin: 0, paddingLeft: 20 }}>{adding.steps.map((s, i) => <li key={i}>{s}</li>)}</ol>
            {adding.auth !== 'none' && (
              <div>
                <Typography.Text strong>API key</Typography.Text>{' '}<Typography.Text type="secondary">(saved to .env only, never shown again; you can also add it later)</Typography.Text>
                <Input.Password value={key} onChange={(e) => setKey(e.target.value)} autoComplete="new-password" placeholder="paste the key" />
              </div>
            )}
            {adding.suggestedLimits && (
              <Alert type="info" showIcon message={`A daily limit of ${adding.suggestedLimits.dailyRequests ? `${adding.suggestedLimits.dailyRequests} requests` : `${(adding.suggestedLimits.dailyTokens ?? 0).toLocaleString()} tokens`} will be set, so the router moves to your next model before the free quota is gone. Change it any time in Providers.`} />
            )}
            <div>
              <Typography.Text strong>Models</Typography.Text>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 4, maxHeight: 240, overflow: 'auto' }}>
                {adding.models.map((m) => {
                  const have = adding.addedModels.includes(m.id);
                  return (
                    <Checkbox key={m.id} checked={picked.includes(m.id)} onChange={(ev) => setPicked((p) => (ev.target.checked ? [...p, m.id] : p.filter((x) => x !== m.id)))}>
                      {m.label} <Typography.Text type="secondary" style={{ fontSize: 12 }}>{m.id}{have ? ' (you already have it; this adds another alias)' : ''}{m.note ? ` · ${m.note}` : ''}</Typography.Text>
                    </Checkbox>
                  );
                })}
              </div>
              <Input style={{ marginTop: 8 }} value={custom} onChange={(e) => setCustom(e.target.value)} placeholder={adding.customModelHint ?? 'or type another model id from the provider'} />
            </div>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>After adding: Models, then the ⚡ button tests the connection. Then pick the model in Claude Code with /model &lt;name&gt;, or put it in a fallback list.</Typography.Text>
          </Space>
        )}
      </Modal>
    </div>
  );
}