/**
 * Settings, one URL per tab: /settings/general | routing | pricing | claude-code | account | system | data
 */
import { CopyOutlined } from '@ant-design/icons';
import { Highlighter } from '@lobehub/ui';
import {
  Alert, App, Button, Card, Descriptions, Form, Input, InputNumber, Popconfirm, Segmented, Select, Space, Switch, Table, Tabs, Tag, Typography,
} from 'antd';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom';
import { api, fetchEtaSnapshot, fetchSnapshot } from '../api';
import { useAppSettings } from '../appSettings';
import { useAuth } from '../auth';
import { fmtBytes, fmtCompact, fmtDateTime, fmtExact, fmtUptime } from '../format';
import { useThemeToggle } from '../theme';
import type { Insights, ModelRow } from '../types';

const TABS = ['general', 'routing', 'pricing', 'guard', 'memory', 'claude-code', 'account', 'system', 'data'] as const;
type Tab = (typeof TABS)[number];

function Section({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <Card size="small" title={title} style={{ marginBottom: 16 }}>
      {description && <Typography.Paragraph type="secondary" style={{ marginTop: 0 }}>{description}</Typography.Paragraph>}
      {children}
    </Card>
  );
}

const cleanErr = (e: unknown): string => (e as Error).message.replace(/^.*failed: \d+ /, '');

export default function SettingsPage() {
  const { tab } = useParams<{ tab: string }>();
  const navigate = useNavigate();
  const { isAdmin } = useAuth();
  if (!tab) return <Navigate to="/settings/general" replace />;
  if (!(TABS as readonly string[]).includes(tab)) return <Navigate to="/settings/general" replace />;
  const active = tab as Tab;
  const labels: Record<Tab, string> = {
    general: 'General', routing: 'Routing', pricing: 'Pricing', guard: 'Context guard', memory: 'Memory', 'claude-code': 'Claude Code', account: 'Account', system: 'System', data: 'Data',
  };
  return (
    <div>
      <Typography.Title level={4} style={{ marginTop: 0 }}>Settings</Typography.Title>
      {!isAdmin && <Alert type="info" showIcon style={{ marginBottom: 16 }} message="Read-only account" description="You can look at everything here, but only admins can change settings." />}
      <Tabs
        activeKey={active}
        onChange={(k) => navigate(`/settings/${k}`)}
        items={TABS.map((t) => ({ key: t, label: labels[t] }))}
      />
      <div style={{ maxWidth: 820 }}>
        {active === 'general' && <General />}
        {active === 'routing' && <Routing />}
        {active === 'pricing' && <Pricing />}
          {active === 'guard' && <Guard />}
        {active === 'memory' && <Memory />}
        {active === 'claude-code' && <ClaudeCode />}
        {active === 'account' && <Account />}
        {active === 'system' && <System />}
        {active === 'data' && <Data />}
      </div>
    </div>
  );
}

// ---------- General ----------
function General() {
  const { message } = App.useApp();
  const { isAdmin } = useAuth();
  const { settings, reload } = useAppSettings();
  const { mode, toggle } = useThemeToggle();
  const [form] = Form.useForm();
  useEffect(() => { form.setFieldsValue(settings); }, [settings, form]);
  const save = async (v: Record<string, unknown>) => {
    try {
      await api('/admin/app-settings', { method: 'PUT', body: JSON.stringify({ settings: v }) });
      await reload();
      message.success('Saved');
    } catch (e) { message.error(cleanErr(e)); }
  };
  return (
    <>
      <Section title="Appearance" description="Stored per browser.">
        <Segmented options={[{ label: 'Dark', value: 'dark' }, { label: 'Light', value: 'light' }]} value={mode} onChange={(v) => v !== mode && toggle()} />
      </Section>
      <Section title="Dashboard">
        <Form form={form} layout="vertical" disabled={!isAdmin} onFinish={save} requiredMark={false}>
          <Form.Item name="ui.projectName" label="Project name" tooltip="Shown next to the logo in the sidebar." rules={[{ required: true, max: 40 }]}>
            <Input style={{ maxWidth: 320 }} />
          </Form.Item>
          <Form.Item name="context.warnTokens" label="Large-prompt warning (tokens)" tooltip="Requests whose prompt is bigger than this are highlighted, and Live warns when most are." rules={[{ required: true, type: 'number', min: 10000, max: 2000000 }]}>
            <InputNumber style={{ width: 200 }} step={10000} min={10000} max={2000000} />
          </Form.Item>
          <Form.Item name="history.retentionDays" label="Keep request history for (days)" tooltip="0 keeps everything. Older rows are deleted automatically." rules={[{ required: true, type: 'number', min: 0, max: 3650 }]}>
            <InputNumber style={{ width: 200 }} min={0} max={3650} />
          </Form.Item>
          {isAdmin && <Button type="primary" htmlType="submit">Save</Button>}
        </Form>
      </Section>
    </>
  );
}

// ---------- Routing (default model + opus/sonnet/haiku slots) ----------
interface RoutingState { version: string; defaultModel: string; aliases: Record<string, string>; models: string[] }

function Routing() {
  const { message } = App.useApp();
  const { isAdmin } = useAuth();
  const [st, setSt] = useState<RoutingState | null>(null);
  const load = useCallback(() => api<RoutingState>('/admin/settings').then(setSt), []);
  useEffect(() => { void load(); }, [load]);
  const { settings, reload } = useAppSettings();
  if (!st) return null;
  const saveApp = async (v: Record<string, unknown>) => {
    try {
      await api('/admin/app-settings', { method: 'PUT', body: JSON.stringify({ settings: v }) });
      await reload();
      message.success('Saved');
    } catch (e) { message.error(cleanErr(e)); }
  };
  const opts = [{ value: '', label: '— none —' }, ...st.models.map((m) => ({ value: m, label: m }))];
  const save = async (patch: Partial<Pick<RoutingState, 'defaultModel' | 'aliases'>>) => {
    try {
      await api('/admin/settings', { method: 'PUT', body: JSON.stringify({ version: st.version, ...patch }) });
      await load();
      message.success('Saved');
    } catch (e) { message.error(cleanErr(e)); }
  };
  return (
    <>
    <Section
      title="When the model you picked fails"
      description={<>Each model can have a fallback list (Models page). <b>Switch automatically</b> keeps you working when a provider runs out of balance or hits a limit, but it means a different model answers. Every such switch is shown in History as a red “asked …” tag with the reason. <b>Stop and show the error</b> never switches: you see the provider's own error in Claude Code. Before it switches or stops, the router retries a rate limit (HTTP 429) on the same key a few times, because those usually clear in a second or two. Errors about balance, quota or permission are not retried.</>}
    >
      <Form layout="vertical" disabled={!isAdmin}>
        <Form.Item label="Behaviour">
          <Segmented
            value={settings['routing.failover']}
            onChange={(v) => void saveApp({ 'routing.failover': v })}
            options={[{ value: 'auto', label: 'Switch automatically' }, { value: 'off', label: 'Stop and show the error' }]}
          />
        </Form.Item>
        <Form.Item label="Quick retries on the same key before giving up" tooltip="0 = never retry. Only short rate-limit and network errors are retried.">
          <InputNumber min={0} max={5} value={settings['routing.retries']} onChange={(v) => v != null && void saveApp({ 'routing.retries': v })} style={{ width: 120 }} />
        </Form.Item>
      </Form>
    </Section>
    <Section title="Which model answers by default" description="Claude Code asks for opus / sonnet / haiku (or any alias you type with /model). These decide where those names go. A name the router does not know falls back to the default model.">
      <Form layout="vertical" disabled={!isAdmin}>
        <Form.Item label="Default model (used for unknown names)">
          <Select style={{ maxWidth: 260 }} value={st.defaultModel} options={opts} onChange={(v) => void save({ defaultModel: v })} />
        </Form.Item>
        {(['opus', 'sonnet', 'haiku'] as const).map((slot) => (
          <Form.Item key={slot} label={`"${slot}" goes to`}>
            <Select style={{ maxWidth: 260 }} value={st.aliases[slot] ?? ''} options={opts} onChange={(v) => void save({ aliases: { [slot]: v } })} />
          </Form.Item>
        ))}
      </Form>
    </Section>
    </>
  );
}

// ---------- Pricing ----------
const DEEPSEEK_PRESETS: { match: RegExp; price: { in: number; out: number; cacheRead: number; peak: boolean }; label: string }[] = [
  { match: /flash/i, price: { in: 0.15, out: 0.6, cacheRead: 0.003, peak: true }, label: 'V4.1 Flash: $0.15 in, $0.60 out, $0.003 cache hit' },
  { match: /pro/i, price: { in: 0.66, out: 1.98, cacheRead: 0.022, peak: true }, label: 'V4 Pro: $0.66 in, $1.98 out, $0.022 cache hit' },
];

function Pricing() {
  const { message } = App.useApp();
  const { isAdmin } = useAuth();
  const { settings, reload } = useAppSettings();
  const [models, setModels] = useState<(ModelRow & { price: ModelRow['price'] & { cacheRead?: number; peak?: boolean } })[]>([]);
  const load = useCallback(async () => {
    const r = await api<{ version: string; models: never[] }>('/admin/models');
    setModels(r.models);
  }, []);
  useEffect(() => { void load(); }, [load]);

  const fill = async () => {
    let n = 0;
    try {
      for (const m of models) {
        if (m.provider !== 'deepseek' || m.price) continue;
        const preset = DEEPSEEK_PRESETS.find((p) => p.match.test(m.model));
        if (!preset) continue;
        const v = (await api<{ version: string }>('/admin/models')).version;
        await api(`/admin/models/${encodeURIComponent(m.alias)}`, { method: 'PUT', body: JSON.stringify({ version: v, price: preset.price }) });
        n++;
      }
      message.success(n ? `Prices set on ${n} model(s)` : 'Nothing to fill: DeepSeek models already have prices');
      await load();
    } catch (e) { message.error(cleanErr(e)); }
  };

  return (
    <>
      <Section
        title="Cost estimates"
        description={<>Cost in the dashboard is <b>estimated</b> from the price on each model (USD per million tokens). It shows $0 for a model with no price. Your provider's own billing page is the source of truth.</>}
      >
        <Table
          size="small"
          rowKey="alias"
          pagination={false}
          dataSource={models}
          columns={[
            { title: 'Model', dataIndex: 'alias' },
            { title: 'Provider', dataIndex: 'provider' },
            { title: 'In', render: (_: unknown, r) => (r.price ? `$${r.price.in}` : <Tag>no price</Tag>) },
            { title: 'Out', render: (_: unknown, r) => (r.price ? `$${r.price.out}` : '—') },
            { title: 'Cache read', render: (_: unknown, r) => (r.price ? (r.price.cacheRead != null ? `$${r.price.cacheRead}` : 'as input') : '—') },
            { title: 'Peak x', render: (_: unknown, r) => (r.price?.peak ? <Tag color="orange">peak</Tag> : '—') },
          ]}
        />
        <Space style={{ marginTop: 12 }}>
          {isAdmin && <Popconfirm title="Set DeepSeek list prices on models that have none?" description="Off-peak prices, September 2026. Check platform.deepseek.com/pricing." onConfirm={() => void fill()}><Button>Fill DeepSeek list prices</Button></Popconfirm>}
          <Link to="/models">Edit prices in Models</Link>
        </Space>
      </Section>
      <Section title="Peak-hours surcharge" description="DeepSeek charges more during its peak window (01:00-04:00 and 06:00-10:00 UTC, Monday to Friday). Models marked “peak” are multiplied by this factor in that window. Chinese public holidays are not modelled.">
        <InputNumber disabled={!isAdmin} min={1} max={10} step={0.5} value={settings['pricing.peakMultiplier']} onChange={async (v) => {
          try { await api('/admin/app-settings', { method: 'PUT', body: JSON.stringify({ settings: { 'pricing.peakMultiplier': v } }) }); await reload(); message.success('Saved'); } catch (e) { message.error(cleanErr(e)); }
        }} addonAfter="x" />
      </Section>
    </>
  );
}

// ---------- Context guard ----------
function Guard() {
  const { message } = App.useApp();
  const { isAdmin } = useAuth();
  const { settings, reload } = useAppSettings();
  const [ins, setIns] = useState<Insights | null>(null);
  const [form] = Form.useForm();
  useEffect(() => { form.setFieldsValue(settings); }, [settings, form]);
  useEffect(() => { void api<Insights>('/admin/insights?range=24h').then(setIns).catch(() => undefined); }, []);

  const save = async (v: Record<string, unknown>) => {
    try {
      await api('/admin/app-settings', { method: 'PUT', body: JSON.stringify({ settings: v }) });
      await reload();
      message.success('Saved');
    } catch (e) { message.error(cleanErr(e)); }
  };

  const g = ins?.guard;
  const raw = g ? g.input + g.saved : 0;
  const pct = g && raw > 0 ? ((g.saved + g.would) / raw) * 100 : 0;
  return (
    <>
      <Section
        title="Why this exists"
        description={<>The model has no memory between requests, so Claude Code sends the whole conversation every time. That cannot be avoided, but most of that conversation is <b>old tool output</b> (files it read, search results, command logs) that the model no longer needs in full. The guard replaces old tool outputs with a one-line note and keeps the newest few. It <b>remembers</b> what it cleared in each session, so later requests get exactly the same notes and the provider's cache keeps working. Clearing happens in rare batches: when the prompt passes the upper limit it is cleared down to the lower limit.</>}
      >
        <Typography.Text type="secondary">
          Research on coding agents (JetBrains, 2025) found this simple approach roughly halves cost while solving as many tasks as summarising with a second model. The risk: the agent may re-read a file it needs again. Start in <b>Measure only</b>, look at the number below, then switch on.
        </Typography.Text>
      </Section>
      <Section title="Result (last 24 hours)">
        {!g || (g.saved === 0 && g.would === 0) ? (
          <Alert type="info" showIcon message="Nothing measured yet" description="It starts counting when a prompt grows past the upper limit. Use Claude Code normally and check back." />
        ) : (
          <Descriptions size="small" column={1} bordered>
            <Descriptions.Item label="Requests affected">{fmtExact(g.requests)}</Descriptions.Item>
            {g.saved > 0 && <Descriptions.Item label="Tokens removed from prompts">{fmtCompact(g.saved)} ({fmtExact(g.saved)})</Descriptions.Item>}
            {g.would > 0 && <Descriptions.Item label="Tokens it would remove (measure only)">{fmtCompact(g.would)} ({fmtExact(g.would)})</Descriptions.Item>}
            <Descriptions.Item label="Share of those prompts">{pct.toFixed(0)}% smaller</Descriptions.Item>
          </Descriptions>
        )}
      </Section>
      <Section title="Settings">
        <Form form={form} layout="vertical" disabled={!isAdmin} requiredMark={false} onFinish={save}>
          <Form.Item name="guard.mode" label="Mode">
            <Segmented options={[{ value: 'off', label: 'Off' }, { value: 'shadow', label: 'Measure only' }, { value: 'on', label: 'On' }]} />
          </Form.Item>
          <Form.Item name="guard.highTokens" label="Start clearing above (tokens)" tooltip="Estimated prompt size that triggers a clearing batch." rules={[{ required: true, type: 'number', min: 20000, max: 2000000 }]}>
            <InputNumber style={{ width: 200 }} step={10000} min={20000} />
          </Form.Item>
          <Form.Item name="guard.lowTokens" label="Clear down to (tokens)" tooltip="Must be lower than the upper limit. A bigger gap means fewer batches and fewer cache misses." rules={[{ required: true, type: 'number', min: 5000, max: 1000000 }]}>
            <InputNumber style={{ width: 200 }} step={5000} min={5000} />
          </Form.Item>
          <Form.Item name="guard.keepRecent" label="Always keep the newest tool outputs" rules={[{ required: true, type: 'number', min: 1, max: 50 }]}>
            <InputNumber style={{ width: 200 }} min={1} max={50} />
          </Form.Item>
          <Form.Item name="guard.minChars" label="Ignore outputs shorter than (characters)" rules={[{ required: true, type: 'number', min: 200, max: 100000 }]}>
            <InputNumber style={{ width: 200 }} step={100} min={200} />
          </Form.Item>
          <Form.Item name="guard.trimInputs" label="Also shrink old tool calls" valuePropName="checked" tooltip="When an old tool output is cleared, the big text inside the matching tool CALL (for example the whole file body of an old Write) is shortened too. The file path and the other fields stay.">
            <Switch />
          </Form.Item>
          <Form.Item name="guard.trimPastes" label="Shrink big pasted text in old messages" valuePropName="checked" tooltip="Your own old messages that contain a very large paste (a log, a file) keep their first 1500 and last 500 characters. Your first message and your newest two are never touched. Off by default because it edits what you wrote.">
            <Switch />
          </Form.Item>
          <Form.Item name="guard.pasteChars" label="A paste counts as big above (characters)" rules={[{ required: true, type: 'number', min: 2000, max: 200000 }]}>
            <InputNumber style={{ width: 200 }} step={1000} min={2000} />
          </Form.Item>
          {isAdmin && <Button type="primary" htmlType="submit">Save</Button>}
        </Form>
      </Section>
    </>
  );
}

// ---------- Memory (rolling summaries) ----------
interface MemoryRow { sessionId: string; covers: number; summaryTokens: number; sourceTokens: number; model: string; cost: number; createdAt: number; summary: string; versions: number }
interface MemoryData { summaries: MemoryRow[]; stats: Insights['memory'] }

function Memory() {
  const { message, modal } = App.useApp();
  const { isAdmin } = useAuth();
  const { settings, reload } = useAppSettings();
  const [data, setData] = useState<MemoryData | null>(null);
  const [aliases, setAliases] = useState<string[]>([]);
  const [form] = Form.useForm();
  const load = useCallback(async () => { setData(await api<MemoryData>('/admin/memory')); }, []);
  useEffect(() => { void load(); void api<{ models: { alias: string }[] }>('/admin/models').then((r) => setAliases(r.models.map((m) => m.alias))); }, [load]);
  useEffect(() => { form.setFieldsValue(settings); }, [settings, form]);
  const save = async (v: Record<string, unknown>) => {
    try {
      await api('/admin/app-settings', { method: 'PUT', body: JSON.stringify({ settings: v }) });
      await reload();
      message.success('Saved');
    } catch (e) { message.error(cleanErr(e)); }
  };
  const st = data?.stats;
  return (
    <>
      <Section
        title="What this is"
        description={<>The AI model has no memory, so Claude Code sends the whole conversation every time. <b>Router memory</b> remembers for it: when a conversation gets long, a cheap model writes a short summary of the <b>old</b> messages (in the background, so nothing waits). The router stores that summary and, from the next request on, sends it <b>instead of</b> the old messages. The text is the same on every request, so the provider's cache keeps working. Your original request is kept word for word, and the newest messages are never summarised. If the summary model fails, your request goes out unchanged and the router tries again after 5 minutes.</>}
      >
        <Typography.Text type="secondary">
          Cost and risk: each summary costs a one-time call to the summary model (shown in History as “router memory summary”), and a summary can lose small details. Start with <b>Measure only</b>, read the number below, then switch on. It only works inside one conversation; after <code>/clear</code> a new conversation starts empty, as it should.
        </Typography.Text>
      </Section>
      <Section title="Result (last 24 hours)">
        {!st || (st.saved === 0 && st.would === 0 && st.summaries === 0) ? (
          <Alert type="info" showIcon message="Nothing yet" description="It starts when a conversation passes the upper limit below." />
        ) : (
          <Descriptions size="small" column={1} bordered>
            {st.saved > 0 && <Descriptions.Item label="Tokens removed from prompts">{fmtCompact(st.saved)} ({fmtExact(st.saved)}) over {fmtExact(st.requests)} requests</Descriptions.Item>}
            {st.would > 0 && <Descriptions.Item label="Tokens it would remove (measure only)">{fmtCompact(st.would)} ({fmtExact(st.would)})</Descriptions.Item>}
            <Descriptions.Item label="Summaries written">{st.summaries}{st.summaries ? ` (read ${fmtCompact(st.summarisedTokens)} tokens, wrote ${fmtCompact(st.summaryTokens)})` : ''}</Descriptions.Item>
            {st.cost > 0 && <Descriptions.Item label="Summary cost (estimate)">${st.cost.toFixed(4)}</Descriptions.Item>}
          </Descriptions>
        )}
      </Section>
      <Section title="Settings">
        <Form form={form} layout="vertical" disabled={!isAdmin} requiredMark={false} onFinish={save}>
          <Form.Item name="memory.mode" label="Mode">
            <Segmented options={[{ value: 'off', label: 'Off' }, { value: 'shadow', label: 'Measure only' }, { value: 'on', label: 'On' }]} />
          </Form.Item>
          <Form.Item name="memory.model" label="Model that writes the summaries" tooltip="Pick a cheap, fast model. It is called only when a summary is needed. Required before you can switch memory on.">
            <Select allowClear style={{ maxWidth: 320 }} placeholder="choose a model" options={aliases.map((a) => ({ value: a, label: a }))} />
          </Form.Item>
          <Form.Item name="memory.highTokens" label="Start summarising above (tokens)" rules={[{ required: true, type: 'number', min: 20000, max: 2000000 }]}>
            <InputNumber style={{ width: 200 }} step={10000} min={20000} />
          </Form.Item>
          <Form.Item name="memory.lowTokens" label="Aim to get down to (tokens)" tooltip="Must be lower than the upper limit." rules={[{ required: true, type: 'number', min: 5000, max: 1000000 }]}>
            <InputNumber style={{ width: 200 }} step={5000} min={5000} />
          </Form.Item>
          {isAdmin && <Button type="primary" htmlType="submit">Save</Button>}
        </Form>
      </Section>
      <Section title="What the router remembers now">
        <Table<MemoryRow>
          size="small"
          rowKey="sessionId"
          pagination={false}
          dataSource={data?.summaries ?? []}
          locale={{ emptyText: 'No summaries yet' }}
          columns={[
            { title: 'Conversation', dataIndex: 'sessionId', render: (v: string) => <code>{v}</code> },
            { title: 'Covers', dataIndex: 'covers', render: (v: number) => `${v} messages` },
            { title: 'Summary', dataIndex: 'summaryTokens', render: (v: number, r) => `${fmtCompact(v)} tokens (from ${fmtCompact(r.sourceTokens)})` },
            { title: 'Updated', dataIndex: 'createdAt', render: (v: number) => fmtDateTime(v) },
            {
              title: '', width: 150,
              render: (_: unknown, r) => (
                <Space size={4}>
                  <Button size="small" type="link" onClick={() => modal.info({ title: `Summary of ${r.sessionId}`, width: 720, content: <pre style={{ whiteSpace: 'pre-wrap', maxHeight: 420, overflow: 'auto', margin: 0 }}>{r.summary}</pre> })}>View</Button>
                  {isAdmin && (
                    <Popconfirm title="Forget this conversation's summary?" description="The next request sends the full conversation again." okText="Forget" onConfirm={async () => { await api(`/admin/memory/${encodeURIComponent(r.sessionId)}`, { method: 'DELETE' }); await load(); }}>
                      <Button size="small" type="link" danger>Forget</Button>
                    </Popconfirm>
                  )}
                </Space>
              ),
            },
          ]}
        />
        {isAdmin && (data?.summaries.length ?? 0) > 0 && (
          <Popconfirm title="Forget all summaries?" okText="Forget all" okButtonProps={{ danger: true }} onConfirm={async () => { await api('/admin/memory/clear', { method: 'POST', body: '{}' }); await load(); }}>
            <Button danger style={{ marginTop: 12 }}>Forget all</Button>
          </Popconfirm>
        )}
      </Section>
    </>
  );
}

// ---------- Claude Code (token efficiency) ----------
interface ModelOpt { alias: string; provider: string; model: string }

/** Builds the exact ~/.claude/settings.json content for THIS router: real port, real statusline path, your models. */
function ClaudeCode() {
  const [models, setModels] = useState<ModelOpt[]>([]);
  const [sys, setSys] = useState<{ port: number; root: string; statusline: string } | null>(null);
  const [pick, setPick] = useState({ opus: '', sonnet: '', haiku: '', fast: '', extra: '', start: 'sonnet' });
  const [withStatus, setWithStatus] = useState(true);
  const [withGuard, setWithGuard] = useState(true);

  useEffect(() => {
    void Promise.all([
      api<{ models: ModelOpt[] }>('/admin/models'),
      api<{ aliases: Record<string, string>; defaultModel: string }>('/admin/settings'),
      api<{ port: number; root: string; statusline: string }>('/admin/system'),
    ]).then(([m, st, sy]) => {
      setModels(m.models);
      setSys(sy);
      setPick((p) => ({
        ...p,
        opus: st.aliases.opus ?? st.defaultModel ?? '',
        sonnet: st.aliases.sonnet ?? st.defaultModel ?? '',
        haiku: st.aliases.haiku ?? st.defaultModel ?? '',
        fast: st.aliases.haiku ?? st.defaultModel ?? '',
      }));
    }).catch(() => undefined);
  }, []);

  const opts = models.map((m) => ({ value: m.alias, label: `${m.alias}  (${m.provider}/${m.model})` }));
  const json = useMemo(() => {
    const env: Record<string, string> = {
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${sys?.port ?? 21450}`,
      ANTHROPIC_AUTH_TOKEN: '<paste the ROUTER_KEY value from your .env>',
    };
    if (pick.opus) env.ANTHROPIC_DEFAULT_OPUS_MODEL = pick.opus;
    if (pick.sonnet) env.ANTHROPIC_DEFAULT_SONNET_MODEL = pick.sonnet;
    if (pick.haiku) env.ANTHROPIC_DEFAULT_HAIKU_MODEL = pick.haiku;
    if (pick.fast) env.ANTHROPIC_SMALL_FAST_MODEL = pick.fast;
    if (pick.extra) {
      env.ANTHROPIC_CUSTOM_MODEL_OPTION = pick.extra;
      env.ANTHROPIC_CUSTOM_MODEL_OPTION_NAME = pick.extra;
      const m = models.find((x) => x.alias === pick.extra);
      env.ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION = m ? `${m.provider}/${m.model}` : pick.extra;
    }
    if (withGuard) {
      env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = '120000';
      env.CLAUDE_CODE_DISABLE_1M_CONTEXT = '1';
    }
    env.API_TIMEOUT_MS = '3000000';
    env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
    const out: Record<string, unknown> = { env, model: pick.start };
    if (withStatus) out.statusLine = { type: 'command', command: `node "${sys?.statusline ?? '/path/to/claude-router/scripts/statusline.mjs'}"` };
    return JSON.stringify(out, null, 2);
  }, [pick, sys, models, withStatus, withGuard]);
  const statusJson = useMemo(
    () => JSON.stringify({ statusLine: { type: 'command', command: `node "${sys?.statusline ?? '/path/to/claude-router/scripts/statusline.mjs'}"` } }, null, 2),
    [sys],
  );
  const sel = (k: keyof typeof pick, label: string, allowEmpty = false) => (
    <div style={{ minWidth: 240, flex: '1 1 240px' }}>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>{label}</Typography.Text>
      <Select
        style={{ width: '100%' }}
        allowClear={allowEmpty}
        placeholder={allowEmpty ? 'none' : undefined}
        value={pick[k] || undefined}
        options={opts}
        onChange={(v) => setPick((p) => ({ ...p, [k]: v ?? '' }))}
      />
    </div>
  );

  return (
    <>
      <Section
        title="Your Claude Code settings.json"
        description={<>Pick which router model each Claude Code slot uses. The JSON below updates live with your real port and file path. <b>Merge</b> the <code>"env"</code>, <code>"model"</code> and <code>"statusLine"</code> parts into <code>~/.claude/settings.json</code> (keep your other settings such as <code>permissions</code>), set <code>ANTHROPIC_AUTH_TOKEN</code> to your <code>ROUTER_KEY</code>, then restart VS Code or the terminal. This file is shared by the VS Code extension and the <code>claude</code> command.</>}
      >
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginBottom: 12 }}>
          {sel('opus', 'Opus row')}
          {sel('sonnet', 'Sonnet row')}
          {sel('haiku', 'Haiku row')}
          {sel('fast', 'Background tasks (small/fast)')}
          {sel('extra', 'One extra picker row', true)}
          <div style={{ minWidth: 240, flex: '1 1 240px' }}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>Start with</Typography.Text>
            <Segmented block value={pick.start} options={['opus', 'sonnet', 'haiku']} onChange={(v) => setPick((p) => ({ ...p, start: String(v) }))} />
          </div>
        </div>
        <Space size={24} wrap style={{ marginBottom: 12 }}>
          <span><Switch size="small" checked={withGuard} onChange={setWithGuard} /> <Typography.Text type="secondary">Compact earlier (saves tokens)</Typography.Text></span>
          <span><Switch size="small" checked={withStatus} onChange={setWithStatus} /> <Typography.Text type="secondary">Status line</Typography.Text></span>
        </Space>
        <Highlighter language="json" fileName="~/.claude/settings.json" copyable variant="filled" style={{ maxHeight: 520, overflow: 'auto' }}>
          {json}
        </Highlighter>
        <Typography.Paragraph type="secondary" style={{ marginBottom: 0, marginTop: 12, fontSize: 13 }}>
          Plain numbers only (<code>120000</code>, never <code>120k</code>). The picker shows Opus, Sonnet, Haiku and one extra row; every other model is chosen by typing <code>/model name</code>. Afterwards watch <Link to="/live">Live</Link> and <Link to="/usage">Usage</Link>: the “Context size” numbers should stop climbing past roughly 90K. Use <code>/clear</code> between unrelated tasks and <code>/compact</code> after a big task.
        </Typography.Paragraph>
      </Section>
      <Section title="Status line only" description="Provider/model, elapsed time, ETA, session tokens and cost in the Claude Code status bar. The path is this router's real location.">
        <Highlighter language="json" fileName="statusLine" copyable variant="filled">
          {statusJson}
        </Highlighter>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          Test it in a terminal: <code>node "{sys?.statusline ?? 'scripts/statusline.mjs'}"</code>. It prints one line, or <code>claude-router - idle</code> when nothing runs.
        </Typography.Text>
      </Section>
    </>
  );
}

// ---------- Account ----------
function Account() {
  const { user } = useAuth();
  const { message } = App.useApp();
  const [form] = Form.useForm();
  return (
    <Section title="Change password" description={<>Signed in as <b>{user?.username}</b> ({user?.role}). Changing the password signs your other sessions out.</>}>
      <Form form={form} layout="vertical" requiredMark={false} style={{ maxWidth: 360 }} onFinish={async (v) => {
        try {
          await api('/admin/auth/password', { method: 'POST', body: JSON.stringify({ current: v.current, next: v.next }) });
          form.resetFields();
          message.success('Password changed');
        } catch (e) { message.error(cleanErr(e)); }
      }}>
        <Form.Item name="current" label="Current password" rules={[{ required: true }]}><Input.Password autoComplete="current-password" /></Form.Item>
        <Form.Item name="next" label="New password" rules={[{ required: true }, { min: 8, message: 'At least 8 characters' }]}><Input.Password autoComplete="new-password" /></Form.Item>
        <Form.Item name="again" label="Repeat new password" dependencies={['next']} rules={[{ required: true }, ({ getFieldValue }) => ({ validator: (_, v) => (!v || getFieldValue('next') === v ? Promise.resolve() : Promise.reject(new Error('Passwords do not match'))) })]}><Input.Password autoComplete="new-password" /></Form.Item>
        <Button type="primary" htmlType="submit">Change password</Button>
      </Form>
    </Section>
  );
}

// ---------- System ----------
interface SystemInfo {
  version: string; node: string; platform: string; pid: number; uptimeSec: number; port: number; timezone: string; memoryMb: number;
  paths: Record<string, string>; database: { bytes: number; requests: number; oldestRequestAt: number | null; users: number };
  usageLogBytes: number; counts: { providers: number; models: number }; sseClients: number;
}

function System() {
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [probe, setProbe] = useState<{ snapshot: string; eta: string } | null>(null);
  const run = useCallback(async () => {
    setInfo(await api<SystemInfo>('/admin/system'));
    const [a, b] = await Promise.allSettled([fetchSnapshot(), fetchEtaSnapshot()]);
    setProbe({
      snapshot: a.status === 'fulfilled' ? `ok · ${a.value.providers.length} providers · ${a.value.models.length} models` : 'failed',
      eta: b.status === 'fulfilled' ? `ok · ${b.value.running.length} running` : 'failed',
    });
  }, []);
  useEffect(() => { void run(); }, [run]);
  if (!info) return null;
  return (
    <>
      <Section title="Router">
        <Descriptions size="small" column={1} bordered>
          <Descriptions.Item label="Version">{info.version || '—'}</Descriptions.Item>
          <Descriptions.Item label="Address">http://127.0.0.1:{info.port}</Descriptions.Item>
          <Descriptions.Item label="Uptime">{fmtUptime(info.uptimeSec)}</Descriptions.Item>
          <Descriptions.Item label="Node / platform">{info.node} · {info.platform} · pid {info.pid}</Descriptions.Item>
          <Descriptions.Item label="Memory">{info.memoryMb} MB</Descriptions.Item>
          <Descriptions.Item label="Time zone">{info.timezone}</Descriptions.Item>
          <Descriptions.Item label="Providers / models">{info.counts.providers} / {info.counts.models}</Descriptions.Item>
          <Descriptions.Item label="Live stream clients">{info.sseClients}</Descriptions.Item>
        </Descriptions>
      </Section>
      <Section title="Health checks" description="The dashboard needs both endpoints.">
        <Space direction="vertical">
          <span>GET /admin/snapshot <Tag color={probe?.snapshot.startsWith('ok') ? 'green' : 'red'}>{probe?.snapshot ?? '…'}</Tag></span>
          <span>GET /admin/eta <Tag color={probe?.eta.startsWith('ok') ? 'green' : 'red'}>{probe?.eta ?? '…'}</Tag></span>
          <Button size="small" onClick={() => void run()}>Recheck</Button>
        </Space>
      </Section>
      <Section title="Files" description="Provider keys live only in .env. They are never sent to this page.">
        <Descriptions size="small" column={1} bordered>
          {Object.entries(info.paths).map(([k, v]) => (
            <Descriptions.Item key={k} label={k}>
              <Typography.Text code copyable={{ icon: <CopyOutlined /> }}>{v}</Typography.Text>
            </Descriptions.Item>
          ))}
        </Descriptions>
      </Section>
    </>
  );
}

// ---------- Data ----------
function Data() {
  const { message } = App.useApp();
  const { isAdmin } = useAuth();
  const { settings } = useAppSettings();
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const load = useCallback(() => api<SystemInfo>('/admin/system').then(setInfo), []);
  useEffect(() => { void load(); }, [load]);
  if (!info) return null;
  return (
    <>
      <Section title="Request history" description="Every request the router handled, stored in a local SQLite file. Powers History, Live and the context numbers in Usage.">
        <Descriptions size="small" column={1} bordered>
          <Descriptions.Item label="Stored requests">{fmtExact(info.database.requests)} ({fmtCompact(info.database.requests)})</Descriptions.Item>
          <Descriptions.Item label="Oldest">{info.database.oldestRequestAt ? fmtDateTime(info.database.oldestRequestAt) : '—'}</Descriptions.Item>
          <Descriptions.Item label="Retention">{settings['history.retentionDays'] ? `${settings['history.retentionDays']} days` : 'forever'} (change under General)</Descriptions.Item>
          <Descriptions.Item label="Database size">{fmtBytes(info.database.bytes)}</Descriptions.Item>
          <Descriptions.Item label="usage.jsonl size">{fmtBytes(info.usageLogBytes)}</Descriptions.Item>
        </Descriptions>
        {isAdmin && (
          <Popconfirm title="Delete all request history?" description="This cannot be undone. Users and settings are kept." okText="Delete" okButtonProps={{ danger: true }} onConfirm={async () => {
            try { const r = await api<{ deleted: number }>('/admin/requests/clear', { method: 'POST', body: '{}' }); message.success(`Deleted ${r.deleted} requests`); await load(); } catch (e) { message.error(cleanErr(e)); }
          }}>
            <Button danger style={{ marginTop: 12 }}>Clear history</Button>
          </Popconfirm>
        )}
      </Section>
    </>
  );
}
