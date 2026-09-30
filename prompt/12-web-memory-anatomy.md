# 12 — Web: Memory tab, prompt breakdown, extra trimming switches, guide update

**Run after 11.** Web UI and the Bangla guide only.

## What this adds

- **Settings > Memory** (new tab): explanation in plain words, mode (Off / Measure only / On), the model that writes the summaries, the two limits, a 24-hour result box (tokens removed or would be removed, summaries written, their cost), and the list of what the router remembers now, with **View** and **Forget**.
- **Settings > Context guard**: three new controls: shrink old tool calls, shrink big pasted text in old messages, and the size at which a paste counts as big.
- **History > Details**: "What this prompt was made of" (stacked bar and list) and a "Router memory" line when a summary was used.
- **Usage**: "Where your prompt tokens go", the average split over recent requests.
- `GUIDE-BN.md`: new sections 8(ক) 8(খ) 8(গ) and two troubleshooting rows.

## How to work (read this first)

- This file is **complete**. Do not open, search or read any other file or folder. For a diff, open only that one file.
- Apply each diff from the repo root with `git apply --ignore-whitespace --whitespace=nowarn <file.patch>` (save the block to a `.patch` file first) or edit by hand: `-` lines removed, `+` lines added, the rest is context. If a hunk already looks like the `+` version, skip it and say so.
- Existing files use Windows line endings (CRLF); keep them. No refactors, no renames, no formatting changes.
- Do **not** touch the user's VS Code settings or `~/.claude/settings.json`. Never print, log or commit `.env` values.
- Finish by running the verification commands and paste their **real output**.

## Steps

### Step 1 — Create this new file

### `src/web/src/components/Anatomy.tsx` — NEW file

````tsx
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
````

### Step 2 — Apply these diffs

### `src/web/src/types.ts` — memory and anatomy fields

````diff
--- a/src/web/src/types.ts
+++ b/src/web/src/types.ts
@@ -241,6 +241,11 @@
   askedAlias: string | null;
   requestedModel: string | null;
   resolvedVia: 'exact' | 'alias' | 'default' | null;
+  /** Router memory: tokens a stored summary removed from this request / would remove (shadow). */
+  memorySaved: number;
+  memoryWould: number;
+  /** Estimated prompt tokens by part, as the client sent it. */
+  anatomy: Record<string, number> | null;
   trace: { route: string; key?: string; outcome: 'served' | 'skipped' | 'failed' | 'retry'; status?: number; detail?: string }[];
 }
 
@@ -282,6 +287,8 @@
   };
   context: { avg: number; p50: number; p90: number; max: number; overWarn: number; compactions: number };
   guard: { requests: number; saved: number; would: number; input: number };
+  memory: { requests: number; saved: number; would: number; summaries: number; summarisedTokens: number; summaryTokens: number; cost: number };
+  anatomy: { requests: number; average: Record<string, number> };
   topSessions: { sessionId: string; requests: number; ctxTotal: number; maxCtx: number; startedAt: number; endedAt: number }[];
   hourly: { t: number; requests: number; ctx: number; out: number; cacheRead: number }[];
 }
````

### `src/web/src/appSettings.tsx` — new settings defaults

````diff
--- a/src/web/src/appSettings.tsx
+++ b/src/web/src/appSettings.tsx
@@ -13,6 +13,13 @@
   'guard.minChars': number;
   'routing.failover': 'auto' | 'off';
   'routing.retries': number;
+  'guard.trimInputs': boolean;
+  'guard.trimPastes': boolean;
+  'guard.pasteChars': number;
+  'memory.mode': 'off' | 'shadow' | 'on';
+  'memory.model': string;
+  'memory.highTokens': number;
+  'memory.lowTokens': number;
 }
 
 const DEFAULTS: AppSettings = {
@@ -27,6 +34,13 @@
   'guard.minChars': 1200,
   'routing.failover': 'auto',
   'routing.retries': 2,
+  'guard.trimInputs': true,
+  'guard.trimPastes': false,
+  'guard.pasteChars': 12_000,
+  'memory.mode': 'shadow',
+  'memory.model': '',
+  'memory.highTokens': 80_000,
+  'memory.lowTokens': 35_000,
 };
 
 interface Ctx {
````

### `src/web/src/pages/History.tsx` — anatomy and memory in Details

````diff
--- a/src/web/src/pages/History.tsx
+++ b/src/web/src/pages/History.tsx
@@ -4,6 +4,7 @@
 import { useSearchParams } from 'react-router-dom';
 import { api, subscribeEta } from '../api';
 import { useAppSettings } from '../appSettings';
+import Anatomy from '../components/Anatomy';
 import { RequestTable, type Row } from '../components/RequestTable';
 import { fmtCompact, fmtDateTime, fmtExact, fmtMs, fmtPct, fmtUsd } from '../format';
 import type { HistoryResponse, HistoryRow } from '../types';
@@ -160,11 +161,20 @@
             <Descriptions.Item label="Time to first token">{fmtMs(open.ttftMs)}</Descriptions.Item>
             <Descriptions.Item label="Duration">{fmtMs(open.durationMs)}</Descriptions.Item>
             <Descriptions.Item label="Cost (estimate)">{fmtUsd(open.cost)}</Descriptions.Item>
+            {(open.memorySaved > 0 || open.memoryWould > 0) && (
+              <Descriptions.Item label="Router memory">{open.memorySaved > 0 ? `old messages replaced by a stored summary, ~${fmtExact(open.memorySaved)} tokens saved` : `a summary would save ~${fmtExact(open.memoryWould)} tokens`}</Descriptions.Item>
+            )}
             {(open.guardSaved > 0 || open.guardWould > 0) && (
               <Descriptions.Item label="Context guard">{open.guardSaved > 0 ? `removed ~${fmtExact(open.guardSaved)} tokens` : `would remove ~${fmtExact(open.guardWould)} tokens`}</Descriptions.Item>
             )}
           </Descriptions>
         )}
+        {open && open.anatomy && (
+          <div style={{ marginTop: 16 }}>
+            <Typography.Text strong>What this prompt was made of</Typography.Text>
+            <div style={{ marginTop: 8 }}><Anatomy data={open.anatomy} /></div>
+          </div>
+        )}
         {open && open.trace.length > 0 && (
           <div style={{ marginTop: 16 }}>
             <Typography.Text strong>Route taken</Typography.Text>
````

### `src/web/src/pages/Usage.tsx` — Where your prompt tokens go

````diff
--- a/src/web/src/pages/Usage.tsx
+++ b/src/web/src/pages/Usage.tsx
@@ -34,6 +34,7 @@
 import type { ColumnsType } from 'antd/es/table';
 import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
 import { api, fetchSnapshot, fetchUsageSummary, subscribeEta } from '../api';
+import Anatomy from '../components/Anatomy';
 import { useAppSettings } from '../appSettings';
 import { fmtCompact, fmtExact, fmtPct, fmtUsd as fmtUsdShared } from '../format';
 import { useThemeMode } from '../theme';
@@ -746,6 +747,15 @@
                 </Panel>
               ) : null}
 
+              {insights && insights.anatomy.requests > 0 ? (
+                <Panel
+                  title="Where your prompt tokens go"
+                  caption={`Average prompt over the last ${insights.anatomy.requests} requests, by part. The biggest bar is where shrinking pays off most. Estimates.`}
+                >
+                  <Anatomy data={insights.anatomy.average} />
+                </Panel>
+              ) : null}
+
               {stackChart && stackedOptions ? (
                 <Panel title="Daily requests by provider" caption="Stacked volume per day in the selected range">
                   <Chart
````

### `src/web/src/pages/Settings.tsx` — Memory tab, extra Context guard controls

````diff
--- a/src/web/src/pages/Settings.tsx
+++ b/src/web/src/pages/Settings.tsx
@@ -15,7 +15,7 @@
 import { useThemeToggle } from '../theme';
 import type { Insights, ModelRow } from '../types';
 
-const TABS = ['general', 'routing', 'pricing', 'guard', 'claude-code', 'account', 'system', 'data'] as const;
+const TABS = ['general', 'routing', 'pricing', 'guard', 'memory', 'claude-code', 'account', 'system', 'data'] as const;
 type Tab = (typeof TABS)[number];
 
 function Section({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
@@ -37,7 +37,7 @@
   if (!(TABS as readonly string[]).includes(tab)) return <Navigate to="/settings/general" replace />;
   const active = tab as Tab;
   const labels: Record<Tab, string> = {
-    general: 'General', routing: 'Routing', pricing: 'Pricing', guard: 'Context guard', 'claude-code': 'Claude Code', account: 'Account', system: 'System', data: 'Data',
+    general: 'General', routing: 'Routing', pricing: 'Pricing', guard: 'Context guard', memory: 'Memory', 'claude-code': 'Claude Code', account: 'Account', system: 'System', data: 'Data',
   };
   return (
     <div>
@@ -53,6 +53,7 @@
         {active === 'routing' && <Routing />}
         {active === 'pricing' && <Pricing />}
         {active === 'guard' && <Guard />}
+        {active === 'memory' && <Memory />}
         {active === 'claude-code' && <ClaudeCode />}
         {active === 'account' && <Account />}
         {active === 'system' && <System />}
@@ -288,11 +289,118 @@
           <Form.Item name="guard.minChars" label="Ignore outputs shorter than (characters)" rules={[{ required: true, type: 'number', min: 200, max: 100000 }]}>
             <InputNumber style={{ width: 200 }} step={100} min={200} />
           </Form.Item>
+          <Form.Item name="guard.trimInputs" label="Also shrink old tool calls" valuePropName="checked" tooltip="When an old tool output is cleared, the big text inside the matching tool CALL (for example the whole file body of an old Write) is shortened too. The file path and the other fields stay.">
+            <Switch />
+          </Form.Item>
+          <Form.Item name="guard.trimPastes" label="Shrink big pasted text in old messages" valuePropName="checked" tooltip="Your own old messages that contain a very large paste (a log, a file) keep their first 1500 and last 500 characters. Your first message and your newest two are never touched. Off by default because it edits what you wrote.">
+            <Switch />
+          </Form.Item>
+          <Form.Item name="guard.pasteChars" label="A paste counts as big above (characters)" rules={[{ required: true, type: 'number', min: 2000, max: 200000 }]}>
+            <InputNumber style={{ width: 200 }} step={1000} min={2000} />
+          </Form.Item>
           {isAdmin && <Button type="primary" htmlType="submit">Save</Button>}
         </Form>
       </Section>
     </>
   );
+}
+
+// ---------- Memory (rolling summaries) ----------
+interface MemoryRow { sessionId: string; covers: number; summaryTokens: number; sourceTokens: number; model: string; cost: number; createdAt: number; summary: string; versions: number }
+interface MemoryData { summaries: MemoryRow[]; stats: Insights['memory'] }
+
+function Memory() {
+  const { message, modal } = App.useApp();
+  const { isAdmin } = useAuth();
+  const { settings, reload } = useAppSettings();
+  const [data, setData] = useState<MemoryData | null>(null);
+  const [aliases, setAliases] = useState<string[]>([]);
+  const [form] = Form.useForm();
+  const load = useCallback(async () => { setData(await api<MemoryData>('/admin/memory')); }, []);
+  useEffect(() => { void load(); void api<{ models: { alias: string }[] }>('/admin/models').then((r) => setAliases(r.models.map((m) => m.alias))); }, [load]);
+  useEffect(() => { form.setFieldsValue(settings); }, [settings, form]);
+  const save = async (v: Record<string, unknown>) => {
+    try {
+      await api('/admin/app-settings', { method: 'PUT', body: JSON.stringify({ settings: v }) });
+      await reload();
+      message.success('Saved');
+    } catch (e) { message.error(cleanErr(e)); }
+  };
+  const st = data?.stats;
+  return (
+    <>
+      <Section
+        title="What this is"
+        description={<>The AI model has no memory, so Claude Code sends the whole conversation every time. <b>Router memory</b> remembers for it: when a conversation gets long, a cheap model writes a short summary of the <b>old</b> messages (in the background, so nothing waits). The router stores that summary and, from the next request on, sends it <b>instead of</b> the old messages. The text is the same on every request, so the provider's cache keeps working. Your original request is kept word for word, and the newest messages are never summarised. If the summary model fails, your request goes out unchanged and the router tries again after 5 minutes.</>}
+      >
+        <Typography.Text type="secondary">
+          Cost and risk: each summary costs a one-time call to the summary model (shown in History as “router memory summary”), and a summary can lose small details. Start with <b>Measure only</b>, read the number below, then switch on. It only works inside one conversation; after <code>/clear</code> a new conversation starts empty, as it should.
+        </Typography.Text>
+      </Section>
+      <Section title="Result (last 24 hours)">
+        {!st || (st.saved === 0 && st.would === 0 && st.summaries === 0) ? (
+          <Alert type="info" showIcon message="Nothing yet" description="It starts when a conversation passes the upper limit below." />
+        ) : (
+          <Descriptions size="small" column={1} bordered>
+            {st.saved > 0 && <Descriptions.Item label="Tokens removed from prompts">{fmtCompact(st.saved)} ({fmtExact(st.saved)}) over {fmtExact(st.requests)} requests</Descriptions.Item>}
+            {st.would > 0 && <Descriptions.Item label="Tokens it would remove (measure only)">{fmtCompact(st.would)} ({fmtExact(st.would)})</Descriptions.Item>}
+            <Descriptions.Item label="Summaries written">{st.summaries}{st.summaries ? ` (read ${fmtCompact(st.summarisedTokens)} tokens, wrote ${fmtCompact(st.summaryTokens)})` : ''}</Descriptions.Item>
+            {st.cost > 0 && <Descriptions.Item label="Summary cost (estimate)">${st.cost.toFixed(4)}</Descriptions.Item>}
+          </Descriptions>
+        )}
+      </Section>
+      <Section title="Settings">
+        <Form form={form} layout="vertical" disabled={!isAdmin} requiredMark={false} onFinish={save}>
+          <Form.Item name="memory.mode" label="Mode">
+            <Segmented options={[{ value: 'off', label: 'Off' }, { value: 'shadow', label: 'Measure only' }, { value: 'on', label: 'On' }]} />
+          </Form.Item>
+          <Form.Item name="memory.model" label="Model that writes the summaries" tooltip="Pick a cheap, fast model. It is called only when a summary is needed. Required before you can switch memory on.">
+            <Select allowClear style={{ maxWidth: 320 }} placeholder="choose a model" options={aliases.map((a) => ({ value: a, label: a }))} />
+          </Form.Item>
+          <Form.Item name="memory.highTokens" label="Start summarising above (tokens)" rules={[{ required: true, type: 'number', min: 20000, max: 2000000 }]}>
+            <InputNumber style={{ width: 200 }} step={10000} min={20000} />
+          </Form.Item>
+          <Form.Item name="memory.lowTokens" label="Aim to get down to (tokens)" tooltip="Must be lower than the upper limit." rules={[{ required: true, type: 'number', min: 5000, max: 1000000 }]}>
+            <InputNumber style={{ width: 200 }} step={5000} min={5000} />
+          </Form.Item>
+          {isAdmin && <Button type="primary" htmlType="submit">Save</Button>}
+        </Form>
+      </Section>
+      <Section title="What the router remembers now">
+        <Table<MemoryRow>
+          size="small"
+          rowKey="sessionId"
+          pagination={false}
+          dataSource={data?.summaries ?? []}
+          locale={{ emptyText: 'No summaries yet' }}
+          columns={[
+            { title: 'Conversation', dataIndex: 'sessionId', render: (v: string) => <code>{v}</code> },
+            { title: 'Covers', dataIndex: 'covers', render: (v: number) => `${v} messages` },
+            { title: 'Summary', dataIndex: 'summaryTokens', render: (v: number, r) => `${fmtCompact(v)} tokens (from ${fmtCompact(r.sourceTokens)})` },
+            { title: 'Updated', dataIndex: 'createdAt', render: (v: number) => fmtDateTime(v) },
+            {
+              title: '', width: 150,
+              render: (_: unknown, r) => (
+                <Space size={4}>
+                  <Button size="small" type="link" onClick={() => modal.info({ title: `Summary of ${r.sessionId}`, width: 720, content: <pre style={{ whiteSpace: 'pre-wrap', maxHeight: 420, overflow: 'auto', margin: 0 }}>{r.summary}</pre> })}>View</Button>
+                  {isAdmin && (
+                    <Popconfirm title="Forget this conversation's summary?" description="The next request sends the full conversation again." okText="Forget" onConfirm={async () => { await api(`/admin/memory/${encodeURIComponent(r.sessionId)}`, { method: 'DELETE' }); await load(); }}>
+                      <Button size="small" type="link" danger>Forget</Button>
+                    </Popconfirm>
+                  )}
+                </Space>
+              ),
+            },
+          ]}
+        />
+        {isAdmin && (data?.summaries.length ?? 0) > 0 && (
+          <Popconfirm title="Forget all summaries?" okText="Forget all" okButtonProps={{ danger: true }} onConfirm={async () => { await api('/admin/memory/clear', { method: 'POST', body: '{}' }); await load(); }}>
+            <Button danger style={{ marginTop: 12 }}>Forget all</Button>
+          </Popconfirm>
+        )}
+      </Section>
+    </>
+  );
 }
 
 // ---------- Claude Code (token efficiency) ----------
````

### `GUIDE-BN.md` — Bangla guide: memory, trimming, prompt anatomy

`````diff
--- a/GUIDE-BN.md
+++ b/GUIDE-BN.md
@@ -180,6 +180,7 @@
 - **Routing:** (ক) **When the model you picked fails** ⇒ `Switch automatically` (ব্যর্থ হলে fallback-এ যাও) বা `Stop and show the error` (যাবে না, আসল error দেখাও), আর ব্যর্থতার আগে কতবার তাৎক্ষণিক retry। (খ) default model আর `opus/sonnet/haiku` কোথায় যাবে।
 - **Pricing:** সব model-এর দাম এক নজরে; **Fill DeepSeek list prices** বাটন; peak-hour গুণক।
 - **Context guard:** ৮ নম্বর অংশ।
+- **Memory:** ৮(খ) নম্বর অংশ: router-এর নিজের "স্মৃতি" (পুরনো কথোপকথনের সারাংশ)।
 - **Claude Code:** তোমার `~/.claude/settings.json`-এর জন্য **তৈরি JSON**। Opus/Sonnet/Haiku/background/এক্সট্রা সারির জন্য ড্রপডাউন থেকে model বাছো; নিচে সুন্দর করে সাজানো (multi-line) JSON আপনাআপনি তৈরি হয়, তাতে তোমার আসল port আর `statusline.mjs`-এর আসল পথ বসানো (Mac/Windows-এ ফাঁকা থাকা ফোল্ডারের নামও ঠিকভাবে escape করা)। উপরে-ডানে কপি বাটন। "Compact earlier" ও "Status line" সুইচ দিয়ে অংশ বাদ দেওয়া যায়। `ANTHROPIC_AUTH_TOKEN`-এ নিজের `ROUTER_KEY` বসাবে (UI কখনো আসল key দেখায় না)। ফাইলে আগে থেকে থাকা বাকি সেটিং (যেমন `permissions`) মুছো না, শুধু `env`, `model`, `statusLine` অংশ মিলিয়ে নাও। নিচে আলাদা **Status line only** বাক্সেও শুধু ওই অংশ আছে।
 - **Account:** নিজের password বদলানো।
 - **System:** router-এর version, চলার সময়, ফাইলের পথ, স্বাস্থ্য পরীক্ষা।
@@ -301,6 +302,24 @@
    - প্রথমে Measure only-তে কয়েকদিন চালাও, সংখ্যা দেখো, তারপর `On`। ঝুঁকি: agent কখনো পুরনো ফাইল আবার পড়তে পারে।
 3. **অভ্যাস:** অন্য কাজ শুরু করলে `/clear`; বড় কাজ শেষে `/compact`; দিন শেষে `/r-end`, পরদিন `/clear` তারপর `/r-start`।
 
+### ৮(ক) আরও ছোট করার দুটো সুইচ (Settings → Context guard)
+- **Also shrink old tool calls** (ডিফল্ট চালু): পুরনো tool output ছাঁটার সময় ওই tool-এর **ডাকের** ভেতরের বড় লেখাও ছোট হয়। যেমন আগের `Write`-এ পুরো ফাইলের লেখা ছিল, এখন থাকে `[router: 9000 characters cleared ...]`; ফাইলের পথ ও বাকি ঘর থাকে।
+- **Shrink big pasted text in old messages** (ডিফল্ট **বন্ধ**, কারণ এটা তোমার নিজের লেখা বদলায়): তোমার পুরনো মেসেজে বিশাল paste (log, ফাইল) থাকলে প্রথম ১৫০০ আর শেষ ৫০০ অক্ষর থাকে। **তোমার প্রথম মেসেজ আর সবচেয়ে নতুন দুটো কখনো ছোঁয়া হয় না।** "A paste counts as big above" ঘরে সীমা (ডিফল্ট ১২,০০০ অক্ষর)।
+
+### ৮(খ) Router Memory: router নিজে মনে রাখে (Settings → Memory)
+- **কেন:** model-এর স্মৃতি নেই, তাই Claude Code পুরো কথোপকথন আবার পাঠায়। Router memory তার হয়ে মনে রাখে: কথোপকথন লম্বা হলে একটা **সস্তা model** (যেটা তুমি বাছো) **পুরনো মেসেজগুলোর সারাংশ** লেখে। সেটা SQLite-এ জমা থাকে, আর পরের request থেকে পুরনো মেসেজের **বদলে** ওই সারাংশ যায়। প্রতিবার হুবহু একই লেখা যায়, তাই provider-এর cache কাজ করে।
+- **অপেক্ষা করতে হয় না:** যে request সীমা পার করে সেটা আগের মতোই যায়। সারাংশ **পেছনে** লেখা হয়, পরের request থেকে কাজে লাগে।
+- **নিরাপত্তা:** তোমার আসল প্রথম অনুরোধ হুবহু সারাংশের ভেতরে থাকে। সবচেয়ে নতুন মেসেজগুলো কখনো সারাংশ হয় না। কথোপকথনের শুরু বদলে গেলে (যেমন Claude Code নিজে `/compact` করলে) পুরনো সারাংশ আর লাগানো হয় না। সারাংশ-model ব্যর্থ হলে তোমার request অপরিবর্তিত যায়, আর router ৫ মিনিট পরে আবার চেষ্টা করে।
+- **খরচ ও ঝুঁকি:** প্রতিটা সারাংশে একবার ওই model-এর খরচ (History-তে "router memory summary" নামে দেখা যায়; কিছু লুকানো নেই), আর সারাংশ থেকে ছোটখাটো খুঁটিনাটি হারাতে পারে। তাই আগে **Measure only**।
+- **ধাপ:** Settings → Memory → **Model that writes the summaries** বাছো (সস্তা, দ্রুতটা, যেমন `ds-flash`) → **Mode: Measure only** → কয়েকদিন পর "Tokens it would remove" দেখো → ঠিক লাগলে **On**। "Start summarising above" (ডিফল্ট ৮০,০০০) ও "Aim to get down to" (৩৫,০০০) বদলানো যায়।
+- **"What the router remembers now"** তালিকায় প্রতিটা কথোপকথনের সারাংশ আছে: **View** দিয়ে পড়তে পারো, **Forget** দিয়ে মুছলে পরের request-এ আবার পুরো কথোপকথন যায়।
+- **সীমা:** এটা এক কথোপকথনের ভেতরে কাজ করে। `/clear` দিলে নতুন কথোপকথন খালি শুরু হয় (এটাই ঠিক)। এক session থেকে আরেক session-এ স্মৃতি নিতে চাইলে প্রজেক্টের ফাইল (`CLAUDE.md`, `.claude/memory`, `/r-end`) ব্যবহার করো।
+
+### ৮(গ) তোমার prompt-এর টোকেন কোথায় যাচ্ছে (ছোট করার আগে দেখো)
+- **Usage → "Where your prompt tokens go":** গত কয়েকশো request-এর গড়, ভাগে ভাগে: Tool results, System prompt, Tool definitions, Tool calls, AI text, তোমার মেসেজ, Thinking, ছবি।
+- **History → কোনো সারির Details → "What this prompt was made of":** ওই এক request-এর ভাগ।
+- সবচেয়ে বড় ফালিটাই ছোট করার জায়গা। সাধারণত Tool results সবচেয়ে বড় হয়; তখন Context guard আর Memory কাজে লাগে। System prompt বা Tool definitions বড় হলে সেটা Claude Code-এর নিজের (কম প্লাগইন/MCP রাখলে কমে); router সেগুলো বদলায় না।
+
 সফল হলো কি না বুঝবে: Live → Context size-এ `p50` আর `p90` আগের ১০৬K/১৫৬K-এর চেয়ে কমছে কি না।
 
 ---
@@ -323,6 +342,8 @@
 | Model-এর ফর্মে Key ঘরটা ধূসর | Provider-এর Auth mode `none`, অথবা "Paste a new API key" খোলা আছে | `none` হলে key লাগে না; নতুন key দিতে চাইলে Auth mode বদলাও |
 | Providers-এ Today লাল | daily limit পৌঁছে গেছে | Edit → limit বাড়াও বা খালি করো, নইলে মধ্যরাত পর্যন্ত এড়ানো হবে |
 | History-র পেজ ২-এ সারি নড়ছে না | ইচ্ছাকৃত: শুধু পেজ ১ নিজে আপডেট হয় | রিফ্রেশ বাটন, বা পেজ ১-এ যাও |
+| Memory On করতে গেলে "choose the model..." | সারাংশ লেখার model বাছা হয়নি | Settings → Memory → model বাছো, তারপর On |
+| Memory On, কিন্তু কিছু বদলাচ্ছে না | prompt এখনো "Start summarising above" সীমার নিচে, বা সারাংশ-model ব্যর্থ (৫ মিনিট পর আবার চেষ্টা) | Live/Usage-এ আকার দেখো; router log-এ `[MEMORY]` লাইন; সীমা কমাও |
 | Fallback-এ গিয়ে "does not fit the ... window" | ছোট-window model-এ prompt ধরছে না | ওটা এড়িয়ে পরেরটা চলে; সমাধান: বড় window-এর model আগে রাখো বা `/compact` |
 | OpenRouter model 404 "ZDR" | OpenRouter অ্যাকাউন্টের privacy সেটিং (Zero Data Retention) ওই model-কে আটকাচ্ছে | openrouter.ai/settings/privacy-তে ZDR সীমা বদলাও বা অন্য model নাও |
 
`````

## Verify

```bash
cd src/web && npx tsc --noEmit && cd ../..    # no output
npm run build                                 # "built in ..."
```
Restart the router and hard-refresh the browser. Checked with a real headless Chromium on this exact code (a 40-step conversation sent three times, summary model `cheap`): Settings > Memory shows "Tokens removed from prompts 104K over 2 requests", "Summaries written 1 (read 7.11K tokens, wrote 144)", the stored summary row with View / Forget; History > Details shows the router-memory line and the prompt bar (tool results 95%, system prompt 4%); the summary call appears in History as its own row; no page errors.
