# 04 — Providers (keys), Models, Settings

**Run after 03.** Changes `src/web/` only.

## What this step adds and why

- **Providers**: the Add-provider form now takes **API keys** (one or many rows; the name is optional and auto-generated; or attach an existing `.env` name), has auth mode **`none`** for keyless local servers, and the Keys dialog lists variables found in `.env` that the provider does not use yet, with **Attach / Attach all**. This is why your `OPENCODE_KEY_2..4` were invisible: a provider only uses the variable names listed in `routes.json`.
- **Models**: the price form keeps and edits the "peak hours" flag.
- **Settings**: seven tabs, one URL each — General (project name, large-prompt limit, history retention), Routing (default model; where opus/sonnet/haiku go), **Pricing** (estimates, DeepSeek list-price preset, peak multiplier), **Claude Code** (the token-saving settings), Account (change password), System (version, uptime, paths, health checks), Data (history size, clear).

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

### Step 1 — Replace this file completely

### `src/web/src/pages/Settings.tsx` — REPLACE the whole file

````tsx
/**
 * Settings, one URL per tab: /settings/general | routing | pricing | claude-code | account | system | data
 */
import { CopyOutlined } from '@ant-design/icons';
import { Snippet } from '@lobehub/ui';
import {
  Alert, App, Button, Card, Descriptions, Form, Input, InputNumber, Popconfirm, Segmented, Select, Space, Table, Tabs, Tag, Typography,
} from 'antd';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom';
import { api, fetchEtaSnapshot, fetchSnapshot } from '../api';
import { useAppSettings } from '../appSettings';
import { useAuth } from '../auth';
import { fmtBytes, fmtCompact, fmtDateTime, fmtExact, fmtUptime } from '../format';
import { useThemeToggle } from '../theme';
import type { ModelRow } from '../types';

const TABS = ['general', 'routing', 'pricing', 'claude-code', 'account', 'system', 'data'] as const;
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
    general: 'General', routing: 'Routing', pricing: 'Pricing', 'claude-code': 'Claude Code', account: 'Account', system: 'System', data: 'Data',
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
  if (!st) return null;
  const opts = [{ value: '', label: '— none —' }, ...st.models.map((m) => ({ value: m, label: m }))];
  const save = async (patch: Partial<Pick<RoutingState, 'defaultModel' | 'aliases'>>) => {
    try {
      await api('/admin/settings', { method: 'PUT', body: JSON.stringify({ version: st.version, ...patch }) });
      await load();
      message.success('Saved');
    } catch (e) { message.error(cleanErr(e)); }
  };
  return (
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

// ---------- Claude Code (token efficiency) ----------
const ENV_SNIPPET = `"CLAUDE_CODE_AUTO_COMPACT_WINDOW": "120000",
"CLAUDE_CODE_DISABLE_1M_CONTEXT": "1"`;
const STATUSLINE_SNIPPET = '{"statusLine": { "type": "command", "command": "node \\"/absolute/path/to/claude-router/scripts/statusline.mjs\\"" } }';

function ClaudeCode() {
  return (
    <>
      <Section
        title="Keep prompts small (the biggest token saving)"
        description={<>Claude Code re-sends the whole conversation on every request. The bigger the conversation, the more tokens each request costs, even when most of it is cached. Ask it to summarise earlier, at a size you choose, instead of waiting for the model's full window. Add these two lines inside the <code>"env"</code> block of <code>~/.claude/settings.json</code>:</>}
      >
        <Snippet language="json">{ENV_SNIPPET}</Snippet>
        <Typography.Paragraph type="secondary" style={{ marginBottom: 0, marginTop: 12 }}>
          The value must be a plain number (write 120000, not 120k). You can also run <code>/autocompact 120k</code> once inside Claude Code, which saves the same setting.
          Then watch <Link to="/live">Live</Link> and <Link to="/usage">Usage</Link>: the “Context size” numbers should stop climbing past roughly 90k.
          Use <code>/clear</code> between unrelated tasks and <code>/compact</code> after a big task. Run <code>/context</code> to see what fills the window.
        </Typography.Paragraph>
      </Section>
      <Section title="Status line" description="Provider/model, elapsed time, ETA, session tokens and cost in the Claude Code status bar.">
        <Snippet language="json">{STATUSLINE_SNIPPET}</Snippet>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>Replace the path with your real repo path. Test with <code>node scripts/statusline.mjs</code>.</Typography.Text>
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
````

### Step 2 — Apply these diffs

### `src/web/src/pages/Providers.tsx` — keys on create, keyless mode, attach from .env

````diff
--- a/src/web/src/pages/Providers.tsx
+++ b/src/web/src/pages/Providers.tsx
@@ -92,7 +92,7 @@
 
 // ---------- Accurate admin view types (server shapes) ----------
 
-export type AuthMode = 'bearer' | 'x-api-key' | 'both';
+export type AuthMode = 'bearer' | 'x-api-key' | 'both' | 'none';
 
 export interface AdminKeyView {
   envName: string;
@@ -110,6 +110,7 @@
   dropBeta: boolean;
   dropBodyFields: string[];
   disabled: boolean;
+  keyless?: boolean;
   keys: AdminKeyView[];
   keysTotal: number;
   keysHealthy: number;
@@ -418,8 +419,17 @@
   { value: 'bearer', label: 'bearer' },
   { value: 'x-api-key', label: 'x-api-key' },
   { value: 'both', label: 'both' },
+  { value: 'none', label: 'none (no key needed, e.g. a local Ollama)' },
 ];
 
+interface DiscoveredKey {
+  envName: string;
+  configured: boolean;
+  last4: string;
+  attachedTo: string | null;
+  suggestedProvider: string | null;
+}
+
 // ---------- Provider add/edit modal ----------
 
 interface ProviderFormValues {
@@ -429,6 +439,7 @@
   dropBeta: boolean;
   dropBodyFields?: string[];
   disabled: boolean;
+  keys?: { envName?: string; value?: string }[];
 }
 
 function ProviderFormModal({
@@ -460,7 +471,7 @@
             dropBodyFields: provider.dropBodyFields,
             disabled: provider.disabled,
           }
-        : { auth: 'bearer', dropBeta: false, dropBodyFields: [], disabled: false },
+        : { auth: 'bearer', dropBeta: false, dropBodyFields: [], disabled: false, keys: [{}] },
     );
     // Only on open / different provider: the 20s snapshot poll swaps the `provider` object and
     // would otherwise reset the form under the user's hands.
@@ -496,6 +507,12 @@
             dropBeta: values.dropBeta,
             dropBodyFields: values.dropBodyFields ?? [],
             disabled: values.disabled,
+            keys:
+              values.auth === 'none'
+                ? []
+                : (values.keys ?? [])
+                    .filter((k) => k && (k.value || k.envName))
+                    .map((k) => ({ envName: k.envName?.trim() || undefined, value: k.value?.trim() || undefined })),
           }),
         }),
       );
@@ -536,6 +553,42 @@
         <Form.Item name="auth" label="Auth mode" rules={[{ required: true }]}>
           <Select options={AUTH_MODE_OPTIONS} />
         </Form.Item>
+        {!isEdit && (
+          <Form.Item noStyle shouldUpdate={(a, b) => a.auth !== b.auth}>
+            {({ getFieldValue }) =>
+              getFieldValue('auth') === 'none' ? (
+                <Alert type="info" showIcon style={{ marginBottom: 16 }} message="No key needed" description="Requests are sent without an Authorization header. Use this for a local server such as Ollama or LM Studio." />
+              ) : (
+                <>
+                  <Typography.Text strong>API keys</Typography.Text>
+                  <Typography.Paragraph type="secondary" style={{ margin: '2px 0 8px' }}>
+                    Paste one or more keys. Each is written to .env only and never shown again. Leave the name empty to get an automatic one such as MY_PROVIDER_KEY_1. To attach a variable that already exists in .env, type its name and leave the value empty.
+                  </Typography.Paragraph>
+                  <Form.List name="keys">
+                    {(fields, { add, remove }) => (
+                      <>
+                        {fields.map((f) => (
+                          <div key={f.key} style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
+                            <Form.Item name={[f.name, 'envName']} style={{ flex: '0 0 40%', margin: 0 }} rules={[{ pattern: ENV_NAME_RE, message: 'e.g. MY_PROVIDER_KEY_1' }]}>
+                              <Input placeholder="ENV_NAME (optional)" autoComplete="off" />
+                            </Form.Item>
+                            <Form.Item name={[f.name, 'value']} style={{ flex: 1, margin: 0 }}>
+                              <Input.Password placeholder="secret value" autoComplete="new-password" />
+                            </Form.Item>
+                            <Button type="text" danger icon={<DeleteOutlined />} onClick={() => remove(f.name)} aria-label="Remove key row" />
+                          </div>
+                        ))}
+                        <Button type="dashed" icon={<PlusOutlined />} onClick={() => add({})} style={{ marginBottom: 16 }}>
+                          Add another key
+                        </Button>
+                      </>
+                    )}
+                  </Form.List>
+                </>
+              )
+            }
+          </Form.Item>
+        )}
         <Form.Item
           name="dropBodyFields"
           label="Drop body fields"
@@ -612,11 +665,39 @@
 }) {
   const [form] = Form.useForm<AddKeyFormValues>();
   const { message } = App.useApp();
+  const [found, setFound] = useState<DiscoveredKey[]>([]);
+  const providerName = provider?.name;
+  const keyCount = provider?.keys.length ?? 0;
+
+  // Variables that exist in .env but are not in this provider's key pool yet.
+  useEffect(() => {
+    if (!open || !providerName) return;
+    let dead = false;
+    api<{ keys: DiscoveredKey[] }>(`/admin/env/keys?provider=${encodeURIComponent(providerName)}`)
+      .then((r) => !dead && setFound(r.keys))
+      .catch(() => !dead && setFound([]));
+    return () => {
+      dead = true;
+    };
+  }, [open, providerName, keyCount]);
 
   if (!provider) {
     return <Modal title="Keys" open={open} onCancel={onClose} footer={null} width={640} />;
   }
 
+  const attach = async (envNames: string[]) => {
+    if (!version || !envNames.length) return;
+    await act(
+      `Attach ${envNames.join(', ')}`,
+      () =>
+        api(`/admin/providers/${encodeURIComponent(provider.name)}/keys/attach`, {
+          method: 'POST',
+          body: JSON.stringify({ version, envNames }),
+        }),
+      `Attached ${envNames.length} key(s) from .env`,
+    );
+  };
+
   const addKey = async () => {
     if (!version) return;
     const { envName, value } = await form.validateFields();
@@ -704,6 +785,32 @@
   return (
     <Modal title={`Keys of "${provider.name}"`} open={open} onCancel={onClose} footer={null} width={640}>
       <div>
+        {provider.keyless && <Alert type="info" showIcon style={{ marginBottom: 16 }} message="This provider needs no key (auth: none)." />}
+        {found.length > 0 && (
+          <Alert
+            type="warning"
+            showIcon
+            style={{ marginBottom: 16 }}
+            message={`${found.length} key${found.length > 1 ? 's' : ''} found in .env but not used by this provider`}
+            description={
+              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6 }}>
+                {found.map((k) => (
+                  <div key={k.envName} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
+                    <Typography.Text code>{k.envName}</Typography.Text>
+                    {k.configured ? <Tag color="green">…{k.last4}</Tag> : <Tag>empty in .env</Tag>}
+                    <span style={{ flex: 1 }} />
+                    <Button size="small" disabled={!version} onClick={() => void attach([k.envName])}>Attach</Button>
+                  </div>
+                ))}
+                {found.length > 1 && (
+                  <Button size="small" type="primary" style={{ alignSelf: 'flex-start' }} disabled={!version} onClick={() => void attach(found.map((k) => k.envName))}>
+                    Attach all
+                  </Button>
+                )}
+              </div>
+            }
+          />
+        )}
         <Form form={form} layout="inline" style={{ marginBottom: 16 }}>
             <Form.Item
               name="envName"
@@ -837,7 +944,7 @@
       width: 120,
       render: (_, p) => (
         <Button type="link" size="small" icon={<KeyOutlined />} onClick={() => setKeysFor(p.name)}>
-          {p.keysHealthy}/{p.keysTotal} ready
+          {p.keyless ? 'no key needed' : `${p.keysHealthy}/${p.keysTotal} ready`}
         </Button>
       ),
     },
````

### `src/web/src/pages/Models.tsx` — peak flag in the price form

````diff
--- a/src/web/src/pages/Models.tsx
+++ b/src/web/src/pages/Models.tsx
@@ -19,6 +19,7 @@
   Modal,
   Select,
   Space,
+  Switch,
   Table,
   Tag,
   Tooltip,
@@ -49,7 +50,7 @@
   key?: string;
   maxOutputTokens?: number | null;
   fallback?: string[];
-  price?: { in?: number | null; out?: number | null; cacheRead?: number | null };
+  price?: { in?: number | null; out?: number | null; cacheRead?: number | null; peak?: boolean };
 }
 
 function ModelFormModal({
@@ -83,7 +84,7 @@
             maxOutputTokens: model.maxOutputTokens ?? null,
             fallback: model.fallback,
             price: model.price
-              ? { in: model.price.in, out: model.price.out, cacheRead: model.price.cacheRead ?? null }
+              ? { in: model.price.in, out: model.price.out, cacheRead: model.price.cacheRead ?? null, peak: !!(model.price as { peak?: boolean }).peak }
               : { in: null, out: null, cacheRead: null },
           }
         : {},
@@ -108,6 +109,7 @@
             in: values.price.in,
             out: values.price.out,
             ...(values.price.cacheRead != null ? { cacheRead: values.price.cacheRead } : {}),
+            ...(values.price.peak ? { peak: true } : {}),
           }
         : undefined;
     const body = {
@@ -214,6 +216,9 @@
             </Form.Item>
           </Space.Compact>
         </Form.Item>
+        <Form.Item name={['price', 'peak']} valuePropName="checked" style={{ margin: '8px 0 0' }}>
+          <Switch size="small" /> <Typography.Text type="secondary" style={{ fontSize: 12 }}>Provider charges more in peak hours (DeepSeek). Multiplier is set in Settings &gt; Pricing.</Typography.Text>
+        </Form.Item>
         <Typography.Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 0, fontSize: 12 }}>
           Leave price or max output tokens empty to remove them. Fallbacks are tried in the order listed, one level deep.
         </Typography.Paragraph>
````

## Verify (after 01, 02, 03 and 04 are all applied)

```bash
cd src/web && npx tsc --noEmit    # expect: no output
cd ../.. && npm run build         # expect: "built in ..." and dist/ui/index.html
node scripts/smoke.mjs && node scripts/admin-smoke.mjs   # expect: ALL PASSED twice
```
Then restart the router (PM2 or `npm run serve`) and hard-refresh the browser once. Open `http://127.0.0.1:21450/ui`, create the admin account, then check: the sidebar on the left, `/ui/history` shows your old requests, refreshing `/ui/usage` stays on Usage, Providers > Add provider shows key rows, Providers > opencode > Keys shows your `.env` keys to attach.

What I checked on exactly this code with a real headless Chromium against the built app: first-run setup → create admin → lands on `/ui/live`; wrong password shows "Invalid username or password"; opening `/ui/providers` while signed out returns to `/ui/providers` after sign-in; reload keeps `/ui/usage`; every page and all 7 settings tabs render; Add-provider dialog shows key rows; light theme works; global search opens; **no page errors** (the only console error is the expected 401 from the wrong password). I could not watch the gauge move during a long live request in that sandbox, so check it once on a real Claude Code request.
