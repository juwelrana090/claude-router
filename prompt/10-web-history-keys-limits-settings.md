# 10 — Web: History pages, model API key field, limits, context window, settings.json viewer, guide update

**Run after 09.** Web UI and the Bangla guide only.

## What this adds and why

- **History** gets real pagination: page numbers, page size (25/50/100/200), total and "1-25 of 120". Page, size and filters are in the URL (`/ui/history?page=2&size=50`), so refresh and shared links keep the same rows. The old "Load more" loaded extra rows that **vanished every 10 seconds** when the page auto-refreshed; now only page 1 auto-refreshes (new requests appear at the top) and other pages stay still until you press refresh. Changing a filter returns to page 1; a page past the end jumps to the last page.
- **Model form**: the Key field now has **Paste a new API key for this model** (key is saved to `.env`, added to the provider and pinned, one save), shows `ZAI_KEY_1 (…2222)` style options, and explains when a provider needs no key. New **Context window (tokens)** field.
- **Providers**: new **Daily request limit** and **Daily token budget** fields, and a **Today** column (requests and tokens served since midnight, the limit, red with the reason when reached).
- **Settings > Claude Code** is now a generator: choose which router model fills the Opus / Sonnet / Haiku / background / one extra picker row, and it shows the complete `~/.claude/settings.json` content as formatted multi-line JSON with your real port and the real path of `statusline.mjs` (escaped correctly for spaces and Windows), a copy button, switches for "compact earlier" and "status line", plus a separate status-line-only box.
- `GUIDE-BN.md` gains the new sections (pagination, pasting a key, daily limits, context window, the generator, new troubleshooting rows).

## How to work (read this first)

- This file is **complete**. Do not open, search or read any other file or folder. For a diff, open only that one file.
- Apply each diff from the repo root with `git apply --ignore-whitespace --whitespace=nowarn <file.patch>` (save the block to a `.patch` file first) or edit by hand: `-` lines removed, `+` lines added, the rest is context. If a hunk already looks like the `+` version, skip it and say so.
- Existing files use Windows line endings (CRLF); keep them. No refactors, no renames, no formatting changes.
- Do **not** touch the user's VS Code settings or `~/.claude/settings.json`. Never print, log or commit `.env` values.
- Finish by running the verification commands and paste their **real output**.

## Steps

### Apply these diffs

### `src/web/src/components/RequestTable.tsx` — optional pagination prop

````diff
--- a/src/web/src/components/RequestTable.tsx
+++ b/src/web/src/components/RequestTable.tsx
@@ -1,5 +1,5 @@
 import { Table, Tag, Tooltip, Typography } from 'antd';
-import type { TableColumnsType } from 'antd';
+import type { TableColumnsType, TablePaginationConfig } from 'antd';
 import { fmtCompact, fmtDateTime, fmtExact, fmtMs, fmtPct, fmtTps, fmtUsd } from '../format';
 import type { HistoryRow, RunningRow } from '../types';
 
@@ -82,6 +82,7 @@
   warnTokens: number;
   onOpen?: (r: HistoryRow) => void;
   compact?: boolean;
+  pagination?: TablePaginationConfig | false;
 }) {
   return (
     <Table<Row>
@@ -90,7 +91,7 @@
       loading={props.loading}
       columns={requestColumns(props.warnTokens, props.onOpen)}
       dataSource={props.rows}
-      pagination={false}
+      pagination={props.pagination ?? false}
       scroll={{ x: 980 }}
     />
   );
````

### `src/web/src/pages/History.tsx` — server-side pagination with URL state

````diff
--- a/src/web/src/pages/History.tsx
+++ b/src/web/src/pages/History.tsx
@@ -1,5 +1,5 @@
 import { ReloadOutlined } from '@ant-design/icons';
-import { Alert, Button, Descriptions, Drawer, Input, Segmented, Select, Space, Tag, Typography } from 'antd';
+import { Alert, Button, Descriptions, Drawer, Input, Segmented, Select, Tag, Typography } from 'antd';
 import { useCallback, useEffect, useMemo, useState } from 'react';
 import { useSearchParams } from 'react-router-dom';
 import { api, subscribeEta } from '../api';
@@ -8,49 +8,56 @@
 import { fmtCompact, fmtDateTime, fmtExact, fmtMs, fmtPct, fmtUsd } from '../format';
 import type { HistoryResponse, HistoryRow } from '../types';
 
-const PAGE = 50;
+const SIZES = [25, 50, 100, 200];
+const DEFAULT_SIZE = 25;
 
-/** Persistent request log: survives restarts, includes requests that are still running. */
+/** Persistent request log with real pages. Page, page size and filters live in the URL, so a refresh or a shared link lands on the same rows. */
 export default function HistoryPage() {
   const { settings } = useAppSettings();
   const [params, setParams] = useSearchParams();
   const q = params.get('q') ?? '';
   const status = (params.get('status') ?? 'all') as 'all' | 'ok' | 'error';
   const alias = params.get('alias') ?? '';
+  const size = SIZES.includes(Number(params.get('size'))) ? Number(params.get('size')) : DEFAULT_SIZE;
+  const page = Math.max(1, Math.floor(Number(params.get('page')) || 1));
   const [data, setData] = useState<HistoryResponse | null>(null);
-  const [extra, setExtra] = useState<HistoryRow[]>([]);
   const [loading, setLoading] = useState(true);
   const [aliases, setAliases] = useState<string[]>([]);
   const [open, setOpen] = useState<HistoryRow | null>(null);
   const [search, setSearch] = useState(q);
 
-  const set = (k: string, v: string) => {
+  /** Change URL params. Any filter change goes back to page 1. */
+  const patch = (changes: Record<string, string>, keepPage = false) => {
     const next = new URLSearchParams(params);
-    if (v && v !== 'all') next.set(k, v);
-    else next.delete(k);
+    for (const [k, v] of Object.entries(changes)) {
+      if (v && v !== 'all' && !(k === 'page' && v === '1') && !(k === 'size' && Number(v) === DEFAULT_SIZE)) next.set(k, v);
+      else next.delete(k);
+    }
+    if (!keepPage) next.delete('page');
     setParams(next, { replace: true });
   };
 
   const load = useCallback(async () => {
-    const qs = new URLSearchParams({ limit: String(PAGE) });
+    const qs = new URLSearchParams({ limit: String(size), offset: String((page - 1) * size) });
     if (q) qs.set('q', q);
     if (status !== 'all') qs.set('status', status);
     if (alias) qs.set('alias', alias);
     try {
       setData(await api<HistoryResponse>(`/admin/requests?${qs}`));
-      setExtra([]);
     } finally {
       setLoading(false);
     }
-  }, [q, status, alias]);
+  }, [q, status, alias, size, page]);
 
   useEffect(() => {
     setLoading(true);
     void load();
   }, [load]);
 
-  // Refresh when a request starts or finishes (stream), and every 10s as a safety net.
+  // The newest requests live on page 1, so only page 1 refreshes by itself (a request ending, plus every 10 s).
+  // On any other page the rows stay put; use the refresh button.
   useEffect(() => {
+    if (page !== 1) return;
     let timer: number | undefined;
     const soon = () => {
       window.clearTimeout(timer);
@@ -63,28 +70,24 @@
       window.clearInterval(poll);
       window.clearTimeout(timer);
     };
-  }, [load]);
+  }, [load, page]);
 
   useEffect(() => {
     void api<{ models: { alias: string }[] }>('/admin/models').then((r) => setAliases(r.models.map((m) => m.alias))).catch(() => undefined);
   }, []);
 
-  const more = async () => {
-    const all = [...(data?.rows ?? []), ...extra];
-    const before = all[all.length - 1]?.endedAt;
-    const qs = new URLSearchParams({ limit: String(PAGE), before: String(before) });
-    if (q) qs.set('q', q);
-    if (status !== 'all') qs.set('status', status);
-    if (alias) qs.set('alias', alias);
-    const r = await api<HistoryResponse>(`/admin/requests?${qs}`);
-    setExtra((e) => [...e, ...r.rows]);
-    setData((d) => (d ? { ...d, hasMore: r.hasMore } : d));
-  };
+  // Deleted history or a narrower filter can leave us past the last page: jump back to it.
+  const lastPage = data ? Math.max(1, Math.ceil(data.total / size)) : 1;
+  useEffect(() => {
+    if (data && page > lastPage) patch({ page: String(lastPage) }, true);
+    // eslint-disable-next-line react-hooks/exhaustive-deps
+  }, [data, lastPage, page]);
 
   const rows: Row[] = useMemo(
-    () => [...(data?.running ?? []).map((r) => ({ ...r, running: true as const })), ...(data?.rows ?? []), ...extra],
-    [data, extra],
+    () => [...(page === 1 ? (data?.running ?? []).map((r) => ({ ...r, running: true as const })) : []), ...(data?.rows ?? [])],
+    [data, page],
   );
+  const filtered = !!(q || status !== 'all' || alias);
 
   return (
     <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
@@ -92,7 +95,8 @@
         <div style={{ flex: 1, minWidth: 240 }}>
           <Typography.Title level={4} style={{ margin: 0 }}>History</Typography.Title>
           <Typography.Text type="secondary">
-            {data ? `${fmtExact(data.total)} requests${q || status !== 'all' || alias ? ' match' : ' stored'}` : 'Loading…'} · kept for {settings['history.retentionDays'] || '∞'} days
+            {data ? `${fmtExact(data.total)} requests${filtered ? ' match' : ' stored'}` : 'Loading…'} · kept for {settings['history.retentionDays'] || '∞'} days
+            {page > 1 && <Tag style={{ marginLeft: 8 }}>page {page}: not auto-refreshing</Tag>}
           </Typography.Text>
         </div>
         <Input.Search
@@ -101,26 +105,41 @@
           placeholder="Model, provider, session…"
           value={search}
           onChange={(e) => setSearch(e.target.value)}
-          onSearch={(v) => set('q', v.trim())}
+          onSearch={(v) => patch({ q: v.trim() })}
         />
         <Select
           allowClear
           style={{ width: 150 }}
           placeholder="All models"
           value={alias || undefined}
-          onChange={(v) => set('alias', v ?? '')}
+          onChange={(v) => patch({ alias: v ?? '' })}
           options={aliases.map((a) => ({ value: a, label: a }))}
         />
-        <Segmented value={status} onChange={(v) => set('status', String(v))} options={[{ value: 'all', label: 'All' }, { value: 'ok', label: 'OK' }, { value: 'error', label: 'Errors' }]} />
+        <Segmented value={status} onChange={(v) => patch({ status: String(v) })} options={[{ value: 'all', label: 'All' }, { value: 'ok', label: 'OK' }, { value: 'error', label: 'Errors' }]} />
         <Button icon={<ReloadOutlined />} onClick={() => void load()} aria-label="Refresh" />
       </div>
 
-      {!loading && rows.length === 0 && <Alert type="info" showIcon message="No requests yet" description="Point Claude Code at the router and every request shows up here." />}
+      {!loading && rows.length === 0 && !filtered && <Alert type="info" showIcon message="No requests yet" description="Point Claude Code at the router and every request shows up here." />}
+      {!loading && rows.length === 0 && filtered && <Alert type="info" showIcon message="Nothing matches these filters" />}
 
-      <RequestTable rows={rows} loading={loading} warnTokens={settings['context.warnTokens']} onOpen={setOpen} />
-      {data?.hasMore && (
-        <Button style={{ alignSelf: 'center' }} onClick={() => void more()}>Load more</Button>
-      )}
+      <RequestTable
+        rows={rows}
+        loading={loading}
+        warnTokens={settings['context.warnTokens']}
+        onOpen={setOpen}
+        pagination={{
+          current: page,
+          pageSize: size,
+          total: data?.total ?? 0,
+          showSizeChanger: true,
+          pageSizeOptions: SIZES.map(String),
+          showQuickJumper: (data?.total ?? 0) > size * 5,
+          showTotal: (total, range) => `${fmtExact(range[0])}-${fmtExact(range[1])} of ${fmtExact(total)}`,
+          hideOnSinglePage: false,
+          position: ['bottomRight'],
+          onChange: (p, s) => (s !== size ? patch({ size: String(s), page: '1' }, true) : patch({ page: String(p) }, true)),
+        }}
+      />
 
       <Drawer title="Request details" width={480} open={!!open} onClose={() => setOpen(null)}>
         {open && (
@@ -141,6 +160,9 @@
             <Descriptions.Item label="Time to first token">{fmtMs(open.ttftMs)}</Descriptions.Item>
             <Descriptions.Item label="Duration">{fmtMs(open.durationMs)}</Descriptions.Item>
             <Descriptions.Item label="Cost (estimate)">{fmtUsd(open.cost)}</Descriptions.Item>
+            {(open.guardSaved > 0 || open.guardWould > 0) && (
+              <Descriptions.Item label="Context guard">{open.guardSaved > 0 ? `removed ~${fmtExact(open.guardSaved)} tokens` : `would remove ~${fmtExact(open.guardWould)} tokens`}</Descriptions.Item>
+            )}
           </Descriptions>
         )}
         {open && open.trace.length > 0 && (
@@ -160,7 +182,6 @@
           </div>
         )}
       </Drawer>
-      <Space />
     </div>
   );
 }
````

### `src/web/src/pages/Models.tsx` — paste-a-key UI, context window field

````diff
--- a/src/web/src/pages/Models.tsx
+++ b/src/web/src/pages/Models.tsx
@@ -48,7 +48,10 @@
   provider: string;
   model: string;
   key?: string;
+  newKeyName?: string;
+  newKeyValue?: string;
   maxOutputTokens?: number | null;
+  contextWindow?: number | null;
   fallback?: string[];
   price?: { in?: number | null; out?: number | null; cacheRead?: number | null; peak?: boolean };
 }
@@ -82,6 +85,7 @@
             model: model.model,
             key: model.key,
             maxOutputTokens: model.maxOutputTokens ?? null,
+            contextWindow: (model as { contextWindow?: number }).contextWindow ?? null,
             fallback: model.fallback,
             price: model.price
               ? { in: model.price.in, out: model.price.out, cacheRead: model.price.cacheRead ?? null, peak: !!(model.price as { peak?: boolean }).peak }
@@ -98,7 +102,15 @@
   const selectedProvider: AdminProviderView | undefined = snapshot?.providers.find(
     (p) => p.name === (watchedProvider ?? model?.provider),
   );
-  const keyOptions = (selectedProvider?.keys ?? []).map((k) => ({ value: k.envName, label: k.envName }));
+  const keyOptions = (selectedProvider?.keys ?? []).map((k) => ({
+    value: k.envName,
+    label: `${k.envName}${k.configured ? ` (…${k.last4})` : ' (empty in .env)'}`,
+  }));
+  const keyless = selectedProvider?.auth === 'none';
+  const [pasting, setPasting] = useState(false);
+  useEffect(() => {
+    if (!open) setPasting(false);
+  }, [open]);
 
   const submit = async () => {
     if (!version) return;
@@ -117,7 +129,12 @@
       provider: values.provider,
       model: values.model.trim(),
       key: values.key || null,
+      // A pasted key is added to the provider, saved to .env and pinned to this model in one save.
+      ...(pasting && values.newKeyValue?.trim()
+        ? { newKey: { value: values.newKeyValue.trim(), envName: values.newKeyName?.trim() || undefined } }
+        : {}),
       maxOutputTokens: values.maxOutputTokens ?? null,
+      contextWindow: values.contextWindow ?? null,
       fallback: values.fallback ?? [],
       price: price ?? null,
     };
@@ -183,16 +200,42 @@
           name="key"
           label="Key"
           tooltip="Pin this model to one specific key, or leave empty to use the provider's key pool."
+          extra={keyless ? 'This provider needs no key (auth: none).' : undefined}
         >
           <Select
             allowClear
+            disabled={keyless || pasting}
             placeholder="pool (any healthy key)"
             options={keyOptions}
             notFoundContent={
-              selectedProvider ? 'This provider has no keys yet' : 'Pick a provider first'
+              selectedProvider ? 'This provider has no keys yet. Paste one below.' : 'Pick a provider first'
             }
           />
         </Form.Item>
+        {!keyless && (
+          <div style={{ marginTop: -8, marginBottom: 16 }}>
+            {!pasting ? (
+              <Button type="link" size="small" style={{ padding: 0 }} disabled={!selectedProvider} onClick={() => setPasting(true)}>
+                Paste a new API key for this model
+              </Button>
+            ) : (
+              <div style={{ border: '1px solid rgba(128,128,128,0.25)', borderRadius: 8, padding: 12 }}>
+                <Typography.Paragraph type="secondary" style={{ marginTop: 0, fontSize: 12 }}>
+                  The key is saved to .env (never shown again, only the last 4 characters) and added to the {selectedProvider?.name} provider. This model will use it.
+                </Typography.Paragraph>
+                <Form.Item name="newKeyValue" label="API key" rules={[{ required: true, min: 4, message: 'Paste the key' }]} style={{ marginBottom: 8 }}>
+                  <Input.Password autoComplete="new-password" placeholder="secret value" />
+                </Form.Item>
+                <Form.Item name="newKeyName" label="Name in .env (optional)" rules={[{ pattern: /^[A-Z][A-Z0-9_]{1,63}$/, message: 'e.g. MY_PROVIDER_KEY_2' }]} style={{ marginBottom: 8 }}>
+                  <Input placeholder="automatic, e.g. MY_PROVIDER_KEY_2" autoComplete="off" />
+                </Form.Item>
+                <Button size="small" onClick={() => { setPasting(false); form.setFieldsValue({ newKeyValue: undefined, newKeyName: undefined }); }}>
+                  Cancel, use an existing key
+                </Button>
+              </div>
+            )}
+          </div>
+        )}
         <Form.Item
           name="maxOutputTokens"
           label="Max output tokens"
@@ -200,6 +243,13 @@
         >
           <InputNumber min={1} step={256} style={{ width: '100%' }} placeholder="e.g. 8192" />
         </Form.Item>
+        <Form.Item
+          name="contextWindow"
+          label="Context window (tokens)"
+          tooltip="The model's real context size, from the provider's docs. When a bigger prompt fails over to this model, the router first clears old tool output so it fits, and skips this model if it still cannot fit. Leave empty if unknown."
+        >
+          <InputNumber min={4096} step={1000} style={{ width: '100%' }} placeholder="e.g. 128000" />
+        </Form.Item>
         <Form.Item name="fallback" label="Fallback chain" tooltip="Tried in order when the primary fails.">
           <Select mode="multiple" options={fallbackOptions} placeholder="no fallbacks" />
         </Form.Item>
````

### `src/web/src/pages/Providers.tsx` — daily limit fields, Today column

````diff
--- a/src/web/src/pages/Providers.tsx
+++ b/src/web/src/pages/Providers.tsx
@@ -76,6 +76,7 @@
   Flex,
   Form,
   Input,
+  InputNumber,
   Modal,
   Popconfirm,
   Select,
@@ -89,6 +90,7 @@
 import type { TableColumnsType } from 'antd';
 import { useCallback, useEffect, useState, type ComponentType } from 'react';
 import { ApiError, api } from '../api';
+import { fmtCompact } from '../format';
 
 // ---------- Accurate admin view types (server shapes) ----------
 
@@ -118,6 +120,12 @@
   keysHealthy: number;
   models: string[];
   lastUsed?: number;
+  /** Optional daily caps (null = unlimited) and what the provider has served since local midnight. */
+  dailyRequests?: number | null;
+  dailyTokens?: number | null;
+  today?: { requests: number; tokens: number };
+  /** Set when a daily cap is already reached (the router skips this provider). */
+  budgetReason?: string | null;
 }
 
 export interface AdminModelView {
@@ -441,6 +449,8 @@
   dropBeta: boolean;
   dropBodyFields?: string[];
   disabled: boolean;
+  dailyRequests?: number | null;
+  dailyTokens?: number | null;
   keys?: { envName?: string; value?: string }[];
 }
 
@@ -472,6 +482,8 @@
             dropBeta: provider.dropBeta,
             dropBodyFields: provider.dropBodyFields,
             disabled: provider.disabled,
+            dailyRequests: provider.dailyRequests ?? null,
+            dailyTokens: provider.dailyTokens ?? null,
           }
         : { auth: 'bearer', dropBeta: false, dropBodyFields: [], disabled: false, keys: [{}] },
     );
@@ -494,6 +506,8 @@
             dropBeta: values.dropBeta,
             dropBodyFields: values.dropBodyFields ?? [],
             disabled: values.disabled,
+            dailyRequests: values.dailyRequests ?? null,
+            dailyTokens: values.dailyTokens ?? null,
           }),
         }),
       );
@@ -509,6 +523,8 @@
             dropBeta: values.dropBeta,
             dropBodyFields: values.dropBodyFields ?? [],
             disabled: values.disabled,
+            ...(values.dailyRequests ? { dailyRequests: values.dailyRequests } : {}),
+            ...(values.dailyTokens ? { dailyTokens: values.dailyTokens } : {}),
             keys:
               values.auth === 'none'
                 ? []
@@ -592,6 +608,20 @@
           </Form.Item>
         )}
         <Form.Item
+          name="dailyRequests"
+          label="Daily request limit"
+          tooltip="Optional. When this many successful requests were served today (router clock, resets at midnight), the router skips this provider and uses the next model in the fallback list, instead of waiting for the provider to refuse. Leave empty for no limit. Free tiers often have one, e.g. OpenRouter free models."
+        >
+          <InputNumber min={1} style={{ width: '100%' }} placeholder="no limit" />
+        </Form.Item>
+        <Form.Item
+          name="dailyTokens"
+          label="Daily token budget"
+          tooltip="Optional. Same idea, counted in tokens: fresh input + cache read + cache write + output. Leave empty for no limit."
+        >
+          <InputNumber min={10000} step={100000} style={{ width: '100%' }} placeholder="no limit" />
+        </Form.Item>
+        <Form.Item
           name="dropBodyFields"
           label="Drop body fields"
           tooltip="Request body fields removed before proxying (type to add)."
@@ -951,6 +981,29 @@
       ),
     },
     {
+      title: 'Today',
+      width: 190,
+      render: (_, p) => {
+        const t = p.today ?? { requests: 0, tokens: 0 };
+        const parts: string[] = [`${fmtCompact(t.requests)} req`, `${fmtCompact(t.tokens)} tok`];
+        const hit = !!p.budgetReason;
+        return (
+          <Tooltip title={p.budgetReason ? `${p.budgetReason}. The router skips this provider until midnight or until you raise the limit.` : 'Served since midnight (router clock). Set daily limits in Edit.'}>
+            <div style={{ lineHeight: 1.3 }}>
+              <Text style={{ color: hit ? '#E5675F' : undefined }}>{parts.join(' · ')}</Text>
+              {(p.dailyRequests || p.dailyTokens) && (
+                <div>
+                  <Text type="secondary" style={{ fontSize: 12 }}>
+                    limit {p.dailyRequests ? `${fmtCompact(p.dailyRequests)} req` : ''}{p.dailyRequests && p.dailyTokens ? ' · ' : ''}{p.dailyTokens ? `${fmtCompact(p.dailyTokens)} tok` : ''}
+                  </Text>
+                </div>
+              )}
+            </div>
+          </Tooltip>
+        );
+      },
+    },
+    {
       title: 'Models',
       render: (_, p) =>
         p.models.length ? (
````

### `src/web/src/pages/Settings.tsx` — Claude Code tab: settings.json generator

````diff
--- a/src/web/src/pages/Settings.tsx
+++ b/src/web/src/pages/Settings.tsx
@@ -2,11 +2,11 @@
  * Settings, one URL per tab: /settings/general | routing | pricing | claude-code | account | system | data
  */
 import { CopyOutlined } from '@ant-design/icons';
-import { Snippet } from '@lobehub/ui';
+import { Highlighter } from '@lobehub/ui';
 import {
-  Alert, App, Button, Card, Descriptions, Form, Input, InputNumber, Popconfirm, Segmented, Select, Space, Table, Tabs, Tag, Typography,
+  Alert, App, Button, Card, Descriptions, Form, Input, InputNumber, Popconfirm, Segmented, Select, Space, Switch, Table, Tabs, Tag, Typography,
 } from 'antd';
-import { useCallback, useEffect, useState, type ReactNode } from 'react';
+import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
 import { Link, Navigate, useNavigate, useParams } from 'react-router-dom';
 import { api, fetchEtaSnapshot, fetchSnapshot } from '../api';
 import { useAppSettings } from '../appSettings';
@@ -296,27 +296,113 @@
 }
 
 // ---------- Claude Code (token efficiency) ----------
-const ENV_SNIPPET = `"CLAUDE_CODE_AUTO_COMPACT_WINDOW": "120000",
-"CLAUDE_CODE_DISABLE_1M_CONTEXT": "1"`;
-const STATUSLINE_SNIPPET = '{"statusLine": { "type": "command", "command": "node \\"/absolute/path/to/claude-router/scripts/statusline.mjs\\"" } }';
+interface ModelOpt { alias: string; provider: string; model: string }
 
+/** Builds the exact ~/.claude/settings.json content for THIS router: real port, real statusline path, your models. */
 function ClaudeCode() {
+  const [models, setModels] = useState<ModelOpt[]>([]);
+  const [sys, setSys] = useState<{ port: number; root: string; statusline: string } | null>(null);
+  const [pick, setPick] = useState({ opus: '', sonnet: '', haiku: '', fast: '', extra: '', start: 'sonnet' });
+  const [withStatus, setWithStatus] = useState(true);
+  const [withGuard, setWithGuard] = useState(true);
+
+  useEffect(() => {
+    void Promise.all([
+      api<{ models: ModelOpt[] }>('/admin/models'),
+      api<{ aliases: Record<string, string>; defaultModel: string }>('/admin/settings'),
+      api<{ port: number; root: string; statusline: string }>('/admin/system'),
+    ]).then(([m, st, sy]) => {
+      setModels(m.models);
+      setSys(sy);
+      setPick((p) => ({
+        ...p,
+        opus: st.aliases.opus ?? st.defaultModel ?? '',
+        sonnet: st.aliases.sonnet ?? st.defaultModel ?? '',
+        haiku: st.aliases.haiku ?? st.defaultModel ?? '',
+        fast: st.aliases.haiku ?? st.defaultModel ?? '',
+      }));
+    }).catch(() => undefined);
+  }, []);
+
+  const opts = models.map((m) => ({ value: m.alias, label: `${m.alias}  (${m.provider}/${m.model})` }));
+  const json = useMemo(() => {
+    const env: Record<string, string> = {
+      ANTHROPIC_BASE_URL: `http://127.0.0.1:${sys?.port ?? 21450}`,
+      ANTHROPIC_AUTH_TOKEN: '<paste the ROUTER_KEY value from your .env>',
+    };
+    if (pick.opus) env.ANTHROPIC_DEFAULT_OPUS_MODEL = pick.opus;
+    if (pick.sonnet) env.ANTHROPIC_DEFAULT_SONNET_MODEL = pick.sonnet;
+    if (pick.haiku) env.ANTHROPIC_DEFAULT_HAIKU_MODEL = pick.haiku;
+    if (pick.fast) env.ANTHROPIC_SMALL_FAST_MODEL = pick.fast;
+    if (pick.extra) {
+      env.ANTHROPIC_CUSTOM_MODEL_OPTION = pick.extra;
+      env.ANTHROPIC_CUSTOM_MODEL_OPTION_NAME = pick.extra;
+      const m = models.find((x) => x.alias === pick.extra);
+      env.ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION = m ? `${m.provider}/${m.model}` : pick.extra;
+    }
+    if (withGuard) {
+      env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = '120000';
+      env.CLAUDE_CODE_DISABLE_1M_CONTEXT = '1';
+    }
+    env.API_TIMEOUT_MS = '3000000';
+    env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
+    const out: Record<string, unknown> = { env, model: pick.start };
+    if (withStatus) out.statusLine = { type: 'command', command: `node "${sys?.statusline ?? '/path/to/claude-router/scripts/statusline.mjs'}"` };
+    return JSON.stringify(out, null, 2);
+  }, [pick, sys, models, withStatus, withGuard]);
+  const statusJson = useMemo(
+    () => JSON.stringify({ statusLine: { type: 'command', command: `node "${sys?.statusline ?? '/path/to/claude-router/scripts/statusline.mjs'}"` } }, null, 2),
+    [sys],
+  );
+  const sel = (k: keyof typeof pick, label: string, allowEmpty = false) => (
+    <div style={{ minWidth: 240, flex: '1 1 240px' }}>
+      <Typography.Text type="secondary" style={{ fontSize: 12 }}>{label}</Typography.Text>
+      <Select
+        style={{ width: '100%' }}
+        allowClear={allowEmpty}
+        placeholder={allowEmpty ? 'none' : undefined}
+        value={pick[k] || undefined}
+        options={opts}
+        onChange={(v) => setPick((p) => ({ ...p, [k]: v ?? '' }))}
+      />
+    </div>
+  );
+
   return (
     <>
       <Section
-        title="Keep prompts small (the biggest token saving)"
-        description={<>Claude Code re-sends the whole conversation on every request. The bigger the conversation, the more tokens each request costs, even when most of it is cached. Ask it to summarise earlier, at a size you choose, instead of waiting for the model's full window. Add these two lines inside the <code>"env"</code> block of <code>~/.claude/settings.json</code>:</>}
+        title="Your Claude Code settings.json"
+        description={<>Pick which router model each Claude Code slot uses. The JSON below updates live with your real port and file path. <b>Merge</b> the <code>"env"</code>, <code>"model"</code> and <code>"statusLine"</code> parts into <code>~/.claude/settings.json</code> (keep your other settings such as <code>permissions</code>), set <code>ANTHROPIC_AUTH_TOKEN</code> to your <code>ROUTER_KEY</code>, then restart VS Code or the terminal. This file is shared by the VS Code extension and the <code>claude</code> command.</>}
       >
-        <Snippet language="json">{ENV_SNIPPET}</Snippet>
-        <Typography.Paragraph type="secondary" style={{ marginBottom: 0, marginTop: 12 }}>
-          The value must be a plain number (write 120000, not 120k). You can also run <code>/autocompact 120k</code> once inside Claude Code, which saves the same setting.
-          Then watch <Link to="/live">Live</Link> and <Link to="/usage">Usage</Link>: the “Context size” numbers should stop climbing past roughly 90k.
-          Use <code>/clear</code> between unrelated tasks and <code>/compact</code> after a big task. Run <code>/context</code> to see what fills the window.
+        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginBottom: 12 }}>
+          {sel('opus', 'Opus row')}
+          {sel('sonnet', 'Sonnet row')}
+          {sel('haiku', 'Haiku row')}
+          {sel('fast', 'Background tasks (small/fast)')}
+          {sel('extra', 'One extra picker row', true)}
+          <div style={{ minWidth: 240, flex: '1 1 240px' }}>
+            <Typography.Text type="secondary" style={{ fontSize: 12 }}>Start with</Typography.Text>
+            <Segmented block value={pick.start} options={['opus', 'sonnet', 'haiku']} onChange={(v) => setPick((p) => ({ ...p, start: String(v) }))} />
+          </div>
+        </div>
+        <Space size={24} wrap style={{ marginBottom: 12 }}>
+          <span><Switch size="small" checked={withGuard} onChange={setWithGuard} /> <Typography.Text type="secondary">Compact earlier (saves tokens)</Typography.Text></span>
+          <span><Switch size="small" checked={withStatus} onChange={setWithStatus} /> <Typography.Text type="secondary">Status line</Typography.Text></span>
+        </Space>
+        <Highlighter language="json" fileName="~/.claude/settings.json" copyable variant="filled" style={{ maxHeight: 520, overflow: 'auto' }}>
+          {json}
+        </Highlighter>
+        <Typography.Paragraph type="secondary" style={{ marginBottom: 0, marginTop: 12, fontSize: 13 }}>
+          Plain numbers only (<code>120000</code>, never <code>120k</code>). The picker shows Opus, Sonnet, Haiku and one extra row; every other model is chosen by typing <code>/model name</code>. Afterwards watch <Link to="/live">Live</Link> and <Link to="/usage">Usage</Link>: the “Context size” numbers should stop climbing past roughly 90K. Use <code>/clear</code> between unrelated tasks and <code>/compact</code> after a big task.
         </Typography.Paragraph>
       </Section>
-      <Section title="Status line" description="Provider/model, elapsed time, ETA, session tokens and cost in the Claude Code status bar.">
-        <Snippet language="json">{STATUSLINE_SNIPPET}</Snippet>
-        <Typography.Text type="secondary" style={{ fontSize: 12 }}>Replace the path with your real repo path. Test with <code>node scripts/statusline.mjs</code>.</Typography.Text>
+      <Section title="Status line only" description="Provider/model, elapsed time, ETA, session tokens and cost in the Claude Code status bar. The path is this router's real location.">
+        <Highlighter language="json" fileName="statusLine" copyable variant="filled">
+          {statusJson}
+        </Highlighter>
+        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
+          Test it in a terminal: <code>node "{sys?.statusline ?? 'scripts/statusline.mjs'}"</code>. It prints one line, or <code>claude-router - idle</code> when nothing runs.
+        </Typography.Text>
       </Section>
     </>
   );
````

### `GUIDE-BN.md` — Bangla guide: new features

`````diff
--- a/GUIDE-BN.md
+++ b/GUIDE-BN.md
@@ -150,10 +150,11 @@
   - **Router chose:** সেই নাম থেকে router কোন alias ধরেছে
   - **Answered by:** আসলে কে উত্তর দিল
   - **Route taken:** ধাপে ধাপে কী হয়েছিল। `skipped` (এড়ানো হয়েছে, কারণসহ), `failed`, `retry`, `served`।
-- **Load more:** আরও পুরনো request।
+- **পেজ (Pagination):** টেবিলের নিচে ডানে পেজ নম্বর, আর "25 / page" ড্রপডাউন (25, 50, 100, 200)। পেজ আর সাইজ URL-এ থাকে (`/ui/history?page=2&size=50`), তাই refresh দিলে বা লিংক পাঠালে একই সারিগুলো আসে। সবচেয়ে নতুন request প্রথম পেজে; **শুধু প্রথম পেজ নিজে নিজে আপডেট হয়**। অন্য পেজে সারি স্থির থাকে (উপরে "page N: not auto-refreshing" লেখা আসে), নতুন করে দেখতে রিফ্রেশ বাটন। ফিল্টার বদলালে আবার পেজ ১-এ ফেরে। মোট সংখ্যা ও "1-25 of 120" লেখা থাকে।
 
 ### Providers (`/ui/providers`)
 প্রতিটা সারি এক provider। **Add provider** বাটন উপরে ডানে।
+**Today** কলাম: এই provider আজ (router-এর ঘড়িতে রাত ১২টা থেকে) কতগুলো সফল request ও কত token সামলেছে। Daily limit দেওয়া থাকলে নিচে "limit ..." লেখা থাকে; সীমা পার হলে লাল হয় ও মাউস ধরলে কারণ দেখায় (তখন router ওই provider এড়িয়ে পরের model-এ যায়)।
 সারির ডানের আইকনগুলো: **🔍 (Keys)** key-এর তালিকা, **⚡** এই provider-এর সব model-এ ছোট test, **✎ (Edit)**, **⏻** চালু/বন্ধ (বন্ধ করলে ওই provider এড়িয়ে যায়), **🗑 (Delete)**।
 "Keys 1/2 ready" মানে ২টার মধ্যে ১টা key ব্যবহারযোগ্য।
 
@@ -163,6 +164,7 @@
 - **Provider / Model id:** কোন provider-এর কোন আসল model।
 - **Key / pool:** নির্দিষ্ট key-এ আটকানো (pinned) হলে তার নাম, নইলে provider-এর সব key ঘুরে ঘুরে।
 - **Max out:** এক উত্তরে সর্বোচ্চ কত token (ফাঁকা = সীমা নেই)।
+- **Context window** (Edit-এ): model-এর আসল context আকার (provider-এর ডকুমেন্ট থেকে)। ফাঁকা = অজানা।
 - **Fallbacks:** এটা ব্যর্থ হলে পরপর কোন model-এ যাবে।
 - **Price in/out:** প্রতি ১০ লক্ষ token-এর দাম (খরচের আন্দাজের জন্য)।
 - ডানের আইকন: **⚡** ১ token-এর test request পাঠায় (provider ঠিক আছে কি না তাৎক্ষণিক জানায়, ব্যর্থ হলে provider-এর আসল error দেখায়), **✎ Edit**, **🗑 Delete**।
@@ -178,7 +180,7 @@
 - **Routing:** (ক) **When the model you picked fails** ⇒ `Switch automatically` (ব্যর্থ হলে fallback-এ যাও) বা `Stop and show the error` (যাবে না, আসল error দেখাও), আর ব্যর্থতার আগে কতবার তাৎক্ষণিক retry। (খ) default model আর `opus/sonnet/haiku` কোথায় যাবে।
 - **Pricing:** সব model-এর দাম এক নজরে; **Fill DeepSeek list prices** বাটন; peak-hour গুণক।
 - **Context guard:** ৮ নম্বর অংশ।
-- **Claude Code:** token বাঁচানোর `env` লাইন কপি করার বাক্স।
+- **Claude Code:** তোমার `~/.claude/settings.json`-এর জন্য **তৈরি JSON**। Opus/Sonnet/Haiku/background/এক্সট্রা সারির জন্য ড্রপডাউন থেকে model বাছো; নিচে সুন্দর করে সাজানো (multi-line) JSON আপনাআপনি তৈরি হয়, তাতে তোমার আসল port আর `statusline.mjs`-এর আসল পথ বসানো (Mac/Windows-এ ফাঁকা থাকা ফোল্ডারের নামও ঠিকভাবে escape করা)। উপরে-ডানে কপি বাটন। "Compact earlier" ও "Status line" সুইচ দিয়ে অংশ বাদ দেওয়া যায়। `ANTHROPIC_AUTH_TOKEN`-এ নিজের `ROUTER_KEY` বসাবে (UI কখনো আসল key দেখায় না)। ফাইলে আগে থেকে থাকা বাকি সেটিং (যেমন `permissions`) মুছো না, শুধু `env`, `model`, `statusLine` অংশ মিলিয়ে নাও। নিচে আলাদা **Status line only** বাক্সেও শুধু ওই অংশ আছে।
 - **Account:** নিজের password বদলানো।
 - **System:** router-এর version, চলার সময়, ফাইলের পথ, স্বাস্থ্য পরীক্ষা।
 - **Data:** history কতটা জমেছে, **Clear history** (সব মুছে যাবে, users/settings থাকবে)।
@@ -213,21 +215,34 @@
 1. Models → **Add model**।
 2. **Alias:** `my-gpt` (ছোট হাতের, সংখ্যা, `-`)। **Provider:** ড্রপডাউন থেকে। **Upstream model id:** provider-এর আসল নাম, ঠিক যেভাবে তাদের ডকুমেন্টে আছে (যেমন `deepseek-v4-flash`)। **এটা ভুল হলে provider 400/404 দেবে।**
 3. **Key:** ফাঁকা রাখলে provider-এর সব key ঘুরে ব্যবহার হবে; একটা বাছলে শুধু ওটা।
-4. **Max output tokens:** না দিলে সীমা নেই।
+4. **Max output tokens:** না দিলে সীমা নেই। **Context window:** model-এর আসল আকার দিলে ভালো (ব্যাখ্যা নিচে ৫(ট))।
 5. **Fallback chain:** ব্যর্থ হলে কোন কোন model, ক্রমানুসারে। (একটা model নিজেকে বা ঘুরে নিজেকে fallback দিতে পারে না; loop ধরা পড়লে error বলে।)
 6. **Price:** in / out / cache read (প্রতি ১০ লক্ষ token, USD)। DeepSeek-এর জন্য **peak** সুইচ।
 7. **Save** → সারির **⚡** চাপো। "OK" এলে ঠিক।
 
+### ঙ-১) Model-এর ফর্ম থেকেই নতুন API key বসানো
+Models → **Add model** বা Edit → **Key** ঘরের নিচে **"Paste a new API key for this model"** চাপো। গোপন key বসাও; চাইলে `.env`-এর নাম দাও (ফাঁকা রাখলে নিজে `ZAI_KEY_2` ধরনের নাম বানাবে)। **Save** করলে একবারে তিনটা কাজ হয়: key `.env`-এ লেখা হয়, provider-এর তালিকায় যুক্ত হয়, আর এই model সেই key-তে আটকানো (pinned) হয়। key আর কখনো পুরোটা দেখায় না (শুধু শেষ ৪ অক্ষর)। কোনো কারণে save ব্যর্থ হলে কিছুই তৈরি হয় না। Key-বিহীন provider (Auth mode `none`)-এ এই লিংক আসে না, বদলে লেখা থাকে "needs no key"।
+
 ### ঙ) Model মোছা
 Models → সারির **🗑**। অন্য model-এর fallback তালিকায় থাকলে dialog সতর্ক করবে।
 
 ### চ) Provider মোছা
 Providers → **🗑**। তার model থাকলে dialog জানাবে; "সহ মুছুন" বললে model-গুলোও যায়। `.env`-এর key-র মান মোছে না, শুধু তালিকা থেকে সরে।
 
+### ছ-১) দৈনিক সীমা (daily limit) দিয়ে আগেই অন্য provider-এ যাওয়া
+কিছু provider-এর দিনে request বা token সীমা আছে (যেমন OpenRouter-এর free model)। Providers → Edit → **Daily request limit** বা **Daily token budget** দাও (ফাঁকা = সীমা নেই)। আজকের সংখ্যা সীমায় পৌঁছালে router **provider-কে প্রশ্নই করে না**, সরাসরি fallback-এ যায়, আর History → Details-এ লেখা থাকে: `daily request limit reached (50 of 50 today)`। Token গণনা = নতুন input + cache read + cache write + output। শুধু সফল request গোনা হয়; রাত ১২টায় (router-এর ঘড়ি) আবার শূন্য। সীমা বাড়ালে বা খালি করলে সঙ্গে সঙ্গে আবার চালু। একসাথে অনেক request গেলে সামান্য বেশি যেতে পারে।
+
 ### ছ) Fallback সাজানো: উদাহরণ
 "glm সবসময় glm-এই চলুক, ব্যর্থ হলে চুপচাপ অন্যটায় যেও না": Models → `glm` → **Fallback chain** খালি করো, অথবা Settings → Routing → **Stop and show the error**।
 "glm ব্যর্থ হলে আগে glm-fast, তারপর ds-flash": `glm`-এর Fallback chain-এ ক্রমানুসারে `glm-fast`, `ds-flash`। (fallback এক স্তরের: `glm`-এর তালিকাই শুধু দেখা হয়, `glm-fast`-এর নিজের তালিকা আবার দেখা হয় না।)
 
+### ট) Fallback model-এর context window ছোট হলে (token বাঁচানো ও নিরাপত্তা)
+ধরো `glm`-এ ১২০K token-এর কথোপকথন চলছে, আর glm ব্যর্থ হয়ে `or-b` (ছোট window)-এ যাচ্ছে। না সামলালে provider "prompt too long" বলে ফেরাত। তাই `or-b`-এর Edit-এ **Context window** দাও (যেমন `128000`)। তখন:
+1. prompt window-এর ৯০%-এর মধ্যে হলে কিছুই বদলায় না।
+2. বড় হলে router আগে **পুরনো tool output ছেঁটে** ফিটে আনে (শুধু এই route-এর জন্য; মূল model অপরিবর্তিত)। **কী ছেঁটেছে সেটা মনে রাখে**, তাই এই route-এ পরের request-এও একই লেখা যায় ও cache কাজ করে।
+3. তাতেও না ধরলে ওই route **এড়িয়ে** পরের fallback-এ যায়, আর History-তে কারণ লেখা থাকে।
+আকার না জানা থাকলে ফাঁকা রাখো, তখন আগের মতোই চলে।
+
 ### জ) দাম বসানো (cost $0.00 হটাতে)
 Settings → Pricing → **Fill DeepSeek list prices** (দাম না-থাকা DeepSeek model-এ বসায়) অথবা Models → Edit → Price। দামগুলো তৃতীয় পক্ষের তথ্যে বসানো; provider-এর নিজের দামের পাতা মিলিয়ে নিও।
 
@@ -305,6 +320,10 @@
 | UI-তে বারবার login চাইছে | কুকি মুছছে (private window/অন্য domain) | `http://127.0.0.1:21450/ui` ঠিক এই ঠিকানায়, সাধারণ window-এ |
 | Live-এ গতি মিটার নড়ছে না | কোনো request চলছে না | Claude Code-এ কিছু চালাও |
 | Cost `$0.00` | model-এ দাম বসানো নেই | ৫(জ) |
+| Model-এর ফর্মে Key ঘরটা ধূসর | Provider-এর Auth mode `none`, অথবা "Paste a new API key" খোলা আছে | `none` হলে key লাগে না; নতুন key দিতে চাইলে Auth mode বদলাও |
+| Providers-এ Today লাল | daily limit পৌঁছে গেছে | Edit → limit বাড়াও বা খালি করো, নইলে মধ্যরাত পর্যন্ত এড়ানো হবে |
+| History-র পেজ ২-এ সারি নড়ছে না | ইচ্ছাকৃত: শুধু পেজ ১ নিজে আপডেট হয় | রিফ্রেশ বাটন, বা পেজ ১-এ যাও |
+| Fallback-এ গিয়ে "does not fit the ... window" | ছোট-window model-এ prompt ধরছে না | ওটা এড়িয়ে পরেরটা চলে; সমাধান: বড় window-এর model আগে রাখো বা `/compact` |
 | OpenRouter model 404 "ZDR" | OpenRouter অ্যাকাউন্টের privacy সেটিং (Zero Data Retention) ওই model-কে আটকাচ্ছে | openrouter.ai/settings/privacy-তে ZDR সীমা বদলাও বা অন্য model নাও |
 
 ---
`````

## Verify

```bash
cd src/web && npx tsc --noEmit && cd ../..    # no output
npm run build                                 # "built in ..."
```
Restart the router, hard-refresh the browser. What I checked with a real headless Chromium on exactly this code (router with 120 requests): History shows "120 requests stored" and "1-25 of 120"; page 2 gives 25 different rows (overlap 0) and the URL becomes `/ui/history?page=2`; page 2 stays identical after 12 seconds (longer than the 10 s refresh); reload keeps page 2 and the same rows; `?size=50&page=3` shows rows 101-120; `?page=99` jumps to page 5; in Edit model the "Paste a new API key" box appears, saving pinned `glm` to the new `ZAI_KEY_2` and wrote it to `.env`; Settings > Claude Code shows formatted JSON containing the real `statusline.mjs` path; **no page errors**.
