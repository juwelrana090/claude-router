# 14 — Web: Catalog page, Instructions page, provider protocol, test hints, guide update

**Run after 13.** Web UI and the Bangla guide only.

## What this adds

- **Catalog** (new page, sidebar): cards for the free and low-price providers: what it is, free or low price, format (Claude or OpenAI style), address, limits, privacy notes, models with prices, when and where the facts were checked. **Add** opens a window: paste the key, tick models or type a model id, done in one save. Filter: All / Free to start / Low price.
- **Instructions** (new page, sidebar): how to use free or paid AI in six folds (start in 5 steps, free vs paid, which one when, automatic switching, keep tokens low, when something fails). English and Bangla switch.
- **Providers**: new "Provider speaks" choice (Claude format or OpenAI style) with address help under Base URL, a blue "OpenAI style" tag in the table.
- **Failed connection test**: shows the plain-language hint under the error.
- `GUIDE-BN.md`: Catalog and Instructions pages, the protocol explanation, the Ollama 404 explained with the fix, a free and low-price table with prices, new troubleshooting rows.

## How to work (read this first)

- This file is **complete**. Do not open, search or read any other file or folder. For a diff, open only that one file.
- Apply each diff from the repo root with `git apply --ignore-whitespace --whitespace=nowarn <file.patch>` (save the block to a `.patch` file first) or edit by hand: `-` lines removed, `+` lines added, the rest is context. If a hunk already looks like the `+` version, skip it and say so.
- Existing files use Windows line endings (CRLF); keep them. No refactors, no renames, no formatting changes.
- Do **not** touch the user's VS Code settings or `~/.claude/settings.json`. Never print, log or commit `.env` values.
- Finish by running the verification commands and paste their **real output**.

## Steps

### Step 1 — Create these new files

### `src/web/src/pages/Catalog.tsx` — NEW file

````tsx
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
````

### `src/web/src/pages/Instructions.tsx` — NEW file

````tsx
import { Alert, Card, Collapse, Segmented, Typography } from 'antd';
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';

type Lang = 'en' | 'bn';

interface Section { key: string; title: string; body: ReactNode }

const code = (s: string) => <Typography.Text code>{s}</Typography.Text>;

/** A plain-language guide to using free and paid AI in this router. English and Bangla. */
function sections(lang: Lang): Section[] {
  if (lang === 'bn') {
    return [
      { key: 'start', title: '১. ৫ ধাপে শুরু', body: (
        <ol>
          <li><Link to="/catalog">Catalog</Link> পেজ খোলো। Free বা Low price বাছো।</li>
          <li>কার্ডের <b>Get a key</b> লিংকে গিয়ে একটা API key নাও।</li>
          <li><b>Add</b> চাপো, key বসাও, model টিক দাও, আবার <b>Add</b>।</li>
          <li><Link to="/models">Models</Link> পেজে model-এর ⚡ চাপো। "Reachable" এলে ঠিক।</li>
          <li>Claude Code-এ {code('/model মডেলের-নাম')} লিখে বদলাও।</li>
        </ol>
      ) },
      { key: 'free', title: '২. ফ্রি আর পেইড: কী আশা করবে', body: (
        <ul>
          <li><b>নিজের কম্পিউটারে (Ollama local):</b> সত্যিই ফ্রি ও সীমাহীন, কিন্তু তোমার RAM/GPU যা পারে।</li>
          <li><b>ফ্রি tier (Groq, Gemini, Cerebras, NVIDIA, Mistral, OpenRouter free):</b> দিনে বা মিনিটে সীমা আছে। সীমা ছাড়ালে provider "429" বলে। গোপনীয়তা: কিছু free tier তোমার prompt দিয়ে model উন্নত করতে পারে। গোপন কোড হলে ব্যবহার কোরো না।</li>
          <li><b>ফ্রি শুরু, পরে টাকা (Ollama Cloud, OpenCode Zen):</b> শুরুতে কিছু ফ্রি ক্রেডিট ও ছোট কিছু model; সব model খুলতে ক্রেডিট কিনতে হয়।</li>
          <li><b>কম দামি (DeepSeek, Z.ai, Kimi, MiniMax, Qwen):</b> প্রতি ১০ লাখ token-এ কয়েক ডলার বা তারও কম। কোডিং-এর জন্য সাধারণত সবচেয়ে কাজের।</li>
          <li>ফ্রি তালিকা বদলায়। প্রতিটা কার্ডে লেখা থাকে কবে যাচাই হয়েছে; সংখ্যা ভরসা করার আগে provider-এর পেজে দেখো।</li>
        </ul>
      ) },
      { key: 'pick', title: '৩. কোনটা কখন', body: (
        <ul>
          <li>গোপন বা ক্লায়েন্টের কোড: নিজের কম্পিউটার বা এমন provider যারা training করে না বলে লেখে। ফ্রি tier এড়াও।</li>
          <li>সাধারণ দৈনিক কাজ: একটা কম দামি model (যেমন DeepSeek Flash) + ফ্রি model fallback হিসেবে।</li>
          <li>কঠিন সমস্যা: বড় model (Pro, GLM 5.3, Kimi Code) হাতে বেছে নাও, কাজ হলে আবার ছোটটায় ফেরো।</li>
        </ul>
      ) },
      { key: 'switch', title: '৪. নিজে নিজে বদলে যাওয়া (fallback)', body: (
        <ul>
          <li><Link to="/models">Models</Link> → Edit → <b>Fallback chain</b>-এ যেসব model ক্রমানুসারে চাও সেগুলো বাছো। প্রথমটা ব্যর্থ হলে পরেরটা চলে।</li>
          <li><Link to="/providers">Providers</Link> → Edit → <b>Daily request limit / Daily token budget</b> দিলে ফ্রি quota শেষ হওয়ার <i>আগেই</i> router পরের model-এ যায়। Catalog থেকে যোগ করলে ফ্রি provider-এ এটা নিজে বসে যায়।</li>
          <li>সব সুইচ <Link to="/history">History</Link>-তে লাল "asked …" ট্যাগসহ কারণ লেখা থাকে। বন্ধ করতে Settings → Routing।</li>
        </ul>
      ) },
      { key: 'tokens', title: '৫. token কম রাখা', body: (
        <ul>
          <li>{code('/clear')} অন্য কাজ শুরুর আগে; {code('/compact')} বড় কাজের পরে।</li>
          <li><Link to="/settings/guard">Context guard</Link> ও <Link to="/settings/memory">Memory</Link> চালু করো (আগে Measure only)। Memory-র সারাংশ লেখার জন্য ফ্রি model (যেমন Groq) বাছা যায়।</li>
          <li><Link to="/usage">Usage</Link> → "Where your prompt tokens go" দেখে কোথায় ছাঁটবে ঠিক করো।</li>
        </ul>
      ) },
      { key: 'fix', title: '৬. সমস্যা হলে', body: (
        <ul>
          <li><b>404, "path not found":</b> Base URL ভুল। শেষে {code('/v1/messages')} বা ভুলভাবে {code('/api')} দিও না। Ollama Cloud হলো {code('https://ollama.com')}।</li>
          <li><b>401/403:</b> key ভুল বা মেয়াদ শেষ, অথবা Auth mode মেলেনি (Ollama Cloud-এ bearer বা both)।</li>
          <li><b>429/402:</b> ফ্রি কোটা বা ব্যালেন্স শেষ, বা একসাথে বেশি request। provider-এর usage পেজ দেখো; ফ্রি প্লানে অনেক model বন্ধ থাকে।</li>
          <li><b>400, unknown model:</b> model id হুবহু provider-এর তালিকা থেকে কপি করো।</li>
          <li>Models পেজে ⚡ চাপলে কারণের পাশে সহজ ভাষায় পরামর্শ দেখায়।</li>
        </ul>
      ) },
    ];
  }
  return [
    { key: 'start', title: '1. Start in 5 steps', body: (
      <ol>
        <li>Open <Link to="/catalog">Catalog</Link>. Pick Free or Low price.</li>
        <li>Use the card's <b>Get a key</b> link to create an API key.</li>
        <li>Press <b>Add</b>, paste the key, tick the models, press <b>Add</b> again.</li>
        <li>On <Link to="/models">Models</Link> press the ⚡ button next to the model. “Reachable” means it works.</li>
        <li>In Claude Code type {code('/model model-name')} to switch to it.</li>
      </ol>
    ) },
    { key: 'free', title: '2. Free vs paid: what to expect', body: (
      <ul>
        <li><b>On your own computer (Ollama local):</b> truly free and unlimited, as fast as your RAM or GPU allows.</li>
        <li><b>Free tiers (Groq, Gemini, Cerebras, NVIDIA, Mistral, OpenRouter free):</b> limited per minute or per day. Past the limit the provider answers “429”. Privacy: some free tiers may use your prompts to improve their models, so keep private code away from them.</li>
        <li><b>Free start, pay later (Ollama Cloud, OpenCode Zen):</b> some free credits and a small set of models; buying credits unlocks the rest.</li>
        <li><b>Low price (DeepSeek, Z.ai, Kimi, MiniMax, Qwen):</b> a few dollars or less per million tokens, usually the best value for coding.</li>
        <li>Free lists change. Each card shows when it was checked; confirm numbers on the provider's page before you rely on them.</li>
      </ul>
    ) },
    { key: 'pick', title: '3. Which one when', body: (
      <ul>
        <li>Private or client code: your own computer, or a provider that states it does not train on your data. Avoid free tiers.</li>
        <li>Everyday work: a low-price model (for example DeepSeek Flash) with a free model as fallback.</li>
        <li>Hard problems: pick a big model by hand (Pro, GLM 5.3, Kimi Code), then go back to the small one.</li>
      </ul>
    ) },
    { key: 'switch', title: '4. Automatic switching (fallbacks)', body: (
      <ul>
        <li><Link to="/models">Models</Link> → Edit → <b>Fallback chain</b>: choose the models to try in order. If the first fails, the next answers.</li>
        <li><Link to="/providers">Providers</Link> → Edit → <b>Daily request limit / Daily token budget</b>: the router moves on <i>before</i> a free quota runs out. Providers added from the Catalog get a sensible limit automatically when they are free.</li>
        <li>Every switch shows in <Link to="/history">History</Link> as a red “asked …” tag with the reason. Turn switching off in Settings → Routing.</li>
      </ul>
    ) },
    { key: 'tokens', title: '5. Keep tokens low', body: (
      <ul>
        <li>{code('/clear')} before an unrelated task; {code('/compact')} after a big one.</li>
        <li>Turn on <Link to="/settings/guard">Context guard</Link> and <Link to="/settings/memory">Memory</Link> (start with Measure only). A free model such as Groq can write the memory summaries.</li>
        <li>Open <Link to="/usage">Usage</Link> → “Where your prompt tokens go” to see what to shrink.</li>
      </ul>
    ) },
    { key: 'fix', title: '6. When something fails', body: (
      <ul>
        <li><b>404 “path not found”:</b> wrong Base URL. Do not end it with {code('/v1/messages')} or a stray {code('/api')}. Ollama Cloud is {code('https://ollama.com')}.</li>
        <li><b>401 / 403:</b> wrong or expired key, or Auth mode does not match (Ollama Cloud needs bearer or both).</li>
        <li><b>429 / 402:</b> free quota or balance used up, or too many requests at once. Check the provider's usage page; free plans often allow only some models.</li>
        <li><b>400, unknown model:</b> copy the model id exactly from the provider's list.</li>
        <li>Pressing ⚡ on Models shows a plain-language hint next to the error.</li>
      </ul>
    ) },
  ];
}

export default function InstructionsPage() {
  const [lang, setLang] = useState<Lang>(() => (localStorage.getItem('router-guide-lang') === 'bn' ? 'bn' : 'en'));
  const items = sections(lang);
  return (
    <div style={{ maxWidth: 860 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <div style={{ flex: 1 }}>
          <Typography.Title level={4} style={{ margin: 0 }}>{lang === 'bn' ? 'ফ্রি বা পেইড AI কীভাবে ব্যবহার করবে' : 'How to use free or paid AI'}</Typography.Title>
          <Typography.Text type="secondary">{lang === 'bn' ? 'ছোট, সহজ ধাপে। পুরো বিস্তারিত: প্রজেক্টের GUIDE-BN.md।' : 'Short, plain steps. Full detail: GUIDE-BN.md in the project (Bangla).'}</Typography.Text>
        </div>
        <Segmented value={lang} onChange={(v) => { setLang(v as Lang); localStorage.setItem('router-guide-lang', String(v)); }} options={[{ value: 'en', label: 'English' }, { value: 'bn', label: 'বাংলা' }]} />
      </div>
      <Alert type="info" showIcon style={{ marginBottom: 16 }} message={lang === 'bn' ? 'এই পেজ নির্দেশনা দেয়। ফ্রি সীমা ও দাম বদলায়: প্রতিটা সংখ্যা provider-এর নিজের পেজে যাচাই করে নাও।' : 'This page gives directions. Free limits and prices change: check every number on the provider\'s own page.'} />
      <Card size="small">
        <Collapse ghost defaultActiveKey={['start']} items={items.map((s) => ({ key: s.key, label: <b>{s.title}</b>, children: s.body }))} />
      </Card>
    </div>
  );
}
````

### Step 2 — Apply these diffs

### `src/web/src/pages/Providers.tsx` — protocol field, tag, test hint

````diff
--- a/src/web/src/pages/Providers.tsx
+++ b/src/web/src/pages/Providers.tsx
@@ -95,6 +95,7 @@
 // ---------- Accurate admin view types (server shapes) ----------
 
 export type AuthMode = 'bearer' | 'x-api-key' | 'both' | 'none';
+export type Protocol = 'anthropic' | 'openai';
 
 export interface AdminKeyView {
   envName: string;
@@ -115,6 +116,8 @@
   dropBodyFields: string[];
   disabled: boolean;
   keyless?: boolean;
+  /** anthropic = the provider speaks Claude's format. openai = chat-completions format, converted by the router. */
+  protocol?: Protocol;
   keys: AdminKeyView[];
   keysTotal: number;
   keysHealthy: number;
@@ -377,6 +380,8 @@
   model: string;
   key: AdminKeyView;
   detail: string;
+  /** Plain-language next step when the test failed. */
+  hint?: string | null;
 }
 
 export function useTestModel() {
@@ -408,6 +413,7 @@
                       {r.detail || '(no detail)'}
                     </Typography.Text>
                   </Typography.Paragraph>
+                  {!r.ok && r.hint && <Alert type="warning" showIcon message={r.hint} style={{ marginTop: 8 }} />}
                 </Space>
               ),
             });
@@ -449,6 +455,7 @@
   dropBeta: boolean;
   dropBodyFields?: string[];
   disabled: boolean;
+  protocol?: Protocol;
   dailyRequests?: number | null;
   dailyTokens?: number | null;
   keys?: { envName?: string; value?: string }[];
@@ -482,10 +489,11 @@
             dropBeta: provider.dropBeta,
             dropBodyFields: provider.dropBodyFields,
             disabled: provider.disabled,
+            protocol: provider.protocol ?? 'anthropic',
             dailyRequests: provider.dailyRequests ?? null,
             dailyTokens: provider.dailyTokens ?? null,
           }
-        : { auth: 'bearer', dropBeta: false, dropBodyFields: [], disabled: false, keys: [{}] },
+        : { auth: 'bearer', protocol: 'anthropic', dropBeta: false, dropBodyFields: [], disabled: false, keys: [{}] },
     );
     // Only on open / different provider: the 20s snapshot poll swaps the `provider` object and
     // would otherwise reset the form under the user's hands.
@@ -506,6 +514,7 @@
             dropBeta: values.dropBeta,
             dropBodyFields: values.dropBodyFields ?? [],
             disabled: values.disabled,
+            protocol: values.protocol ?? 'anthropic',
             dailyRequests: values.dailyRequests ?? null,
             dailyTokens: values.dailyTokens ?? null,
           }),
@@ -523,6 +532,7 @@
             dropBeta: values.dropBeta,
             dropBodyFields: values.dropBodyFields ?? [],
             disabled: values.disabled,
+            protocol: values.protocol ?? 'anthropic',
             ...(values.dailyRequests ? { dailyRequests: values.dailyRequests } : {}),
             ...(values.dailyTokens ? { dailyTokens: values.dailyTokens } : {}),
             keys:
@@ -561,12 +571,22 @@
             <Input placeholder="openrouter" autoComplete="off" />
           </Form.Item>
         )}
+        <Form.Item name="protocol" label="Provider speaks" tooltip="Most coding providers have an address that speaks Claude's own format (Anthropic style). Some free ones (Groq, Gemini, Cerebras, NVIDIA, Mistral) only speak the OpenAI chat format: choose OpenAI style and the router converts everything, including tool calls and streaming.">
+          <Select options={[{ value: 'anthropic', label: 'Anthropic style (Claude format)' }, { value: 'openai', label: 'OpenAI style (chat completions), converted by the router' }]} />
+        </Form.Item>
+        <Form.Item noStyle shouldUpdate={(a, b) => a.protocol !== b.protocol}>
+          {({ getFieldValue }) => (
         <Form.Item
           name="baseURL"
           label="Base URL"
+              extra={getFieldValue('protocol') === 'openai'
+                ? 'Ends where /chat/completions starts, for example https://api.groq.com/openai/v1. The router adds /chat/completions.'
+                : 'Do not add /v1/messages: the router adds it. Ollama cloud is https://ollama.com (no /api); Ollama on your computer is http://localhost:11434.'}
           rules={[{ required: true, message: 'required (https, or http for localhost)' }]}
         >
-          <Input placeholder="https://api.example.com" autoComplete="off" />
+              <Input placeholder={getFieldValue('protocol') === 'openai' ? 'https://api.example.com/v1' : 'https://api.example.com'} autoComplete="off" />
+            </Form.Item>
+          )}
         </Form.Item>
         <Form.Item name="auth" label="Auth mode" rules={[{ required: true }]}>
           <Select options={AUTH_MODE_OPTIONS} />
@@ -966,9 +986,16 @@
     {
       title: 'Auth',
       dataIndex: 'auth',
-      width: 110,
-      render: (v: string) => (
+      width: 150,
+      render: (v: string, p) => (
+        <span>
         <Tag icon={<ApiOutlined />}>{v}</Tag>
+          {p.protocol === 'openai' && (
+            <Tooltip title="This provider speaks the OpenAI chat format. The router converts requests and answers for you.">
+              <Tag color="blue">OpenAI style</Tag>
+            </Tooltip>
+          )}
+        </span>
       ),
     },
     {
````

### `src/web/src/App.tsx` — routes /catalog and /instructions

````diff
--- a/src/web/src/App.tsx
+++ b/src/web/src/App.tsx
@@ -3,7 +3,9 @@
 import { AppSettingsProvider } from './appSettings';
 import { useAuth } from './auth';
 import AppShell from './layout/AppShell';
+import CatalogPage from './pages/Catalog';
 import HistoryPage from './pages/History';
+import InstructionsPage from './pages/Instructions';
 import LivePage from './pages/Live';
 import LoginPage from './pages/Login';
 import ModelsPage from './pages/Models';
@@ -28,6 +30,8 @@
           <Route path="live" element={<LivePage />} />
           <Route path="history" element={<HistoryPage />} />
           <Route path="providers" element={<ProvidersPage />} />
+          <Route path="catalog" element={<CatalogPage />} />
+          <Route path="instructions" element={<InstructionsPage />} />
           <Route path="models" element={<ModelsPage />} />
           <Route path="usage" element={<UsagePage />} />
           <Route path="users" element={<UsersPage />} />
````

### `src/web/src/layout/AppShell.tsx` — sidebar items

````diff
--- a/src/web/src/layout/AppShell.tsx
+++ b/src/web/src/layout/AppShell.tsx
@@ -1,5 +1,7 @@
 import {
   ApiOutlined,
+  AppstoreAddOutlined,
+  BookOutlined,
   BarChartOutlined,
   DeploymentUnitOutlined,
   DownOutlined,
@@ -37,9 +39,11 @@
   { path: '/live', label: 'Live', icon: <RadarChartOutlined />, hint: 'Real-time requests and speed' },
   { path: '/history', label: 'History', icon: <HistoryOutlined />, hint: 'Every request, with tokens and timing' },
   { path: '/providers', label: 'Providers', icon: <ApiOutlined />, hint: 'Upstreams, keys and health' },
+  { path: '/catalog', label: 'Catalog', icon: <AppstoreAddOutlined />, hint: 'Free and low-price coding AI, one-click setup' },
   { path: '/models', label: 'Models', icon: <DeploymentUnitOutlined />, hint: 'Aliases, fallbacks and prices' },
   { path: '/usage', label: 'Usage', icon: <BarChartOutlined />, hint: 'Tokens, cost and context size' },
   { path: '/users', label: 'Users', icon: <TeamOutlined />, adminOnly: true, hint: 'Who can sign in' },
+  { path: '/instructions', label: 'Instructions', icon: <BookOutlined />, hint: 'How to use free or paid AI' },
   { path: '/settings', label: 'Settings', icon: <SettingOutlined />, hint: 'System, pricing, data and account' },
 ];
 
````

### `GUIDE-BN.md` — Bangla guide: catalog, protocol, Ollama fix, free and low-price table

`````diff
--- a/GUIDE-BN.md
+++ b/GUIDE-BN.md
@@ -152,6 +152,12 @@
   - **Route taken:** ধাপে ধাপে কী হয়েছিল। `skipped` (এড়ানো হয়েছে, কারণসহ), `failed`, `retry`, `served`।
 - **পেজ (Pagination):** টেবিলের নিচে ডানে পেজ নম্বর, আর "25 / page" ড্রপডাউন (25, 50, 100, 200)। পেজ আর সাইজ URL-এ থাকে (`/ui/history?page=2&size=50`), তাই refresh দিলে বা লিংক পাঠালে একই সারিগুলো আসে। সবচেয়ে নতুন request প্রথম পেজে; **শুধু প্রথম পেজ নিজে নিজে আপডেট হয়**। অন্য পেজে সারি স্থির থাকে (উপরে "page N: not auto-refreshing" লেখা আসে), নতুন করে দেখতে রিফ্রেশ বাটন। ফিল্টার বদলালে আবার পেজ ১-এ ফেরে। মোট সংখ্যা ও "1-25 of 120" লেখা থাকে।
 
+### Catalog (`/ui/catalog`)
+চেনা provider-এর তালিকা, ঠিক ঠিকানা ও সেটিংসহ। কার্ডে আছে: সংক্ষেপে কী, **ফ্রি না কম দামি**, provider-এর **ভাষা** ("Claude format" নাকি "OpenAI style (converted)"), base URL, ফ্রি সীমা, গোপনীয়তার সতর্কতা, model ও দাম (প্রতি ১০ লাখ token, USD), আর "Checked: তারিখ ও উৎস"। **Get a key** লিংক সরাসরি provider-এর key পেজে যায়। **Add** চাপলে জানালা খোলে: key বসাও, model টিক দাও (বা নিজের model id লেখো), **Add**। এক save-এ provider, key (`.env`-এ), model সব তৈরি হয়; ফ্রি provider-এ দৈনিক সীমা নিজে বসে। উপরে ডানে **How to use free or paid AI** লিংক Instructions পেজে যায়।
+
+### Instructions (`/ui/instructions`)
+ইংরেজি ও বাংলা (ডানের সুইচ)। ৬টা ভাঁজ: ৫ ধাপে শুরু; ফ্রি বনাম পেইড; কখন কোনটা; নিজে নিজে বদলে যাওয়া; token কম রাখা; সমস্যা হলে। এই গাইডের ছোট সংস্করণ।
+
 ### Providers (`/ui/providers`)
 প্রতিটা সারি এক provider। **Add provider** বাটন উপরে ডানে।
 **Today** কলাম: এই provider আজ (router-এর ঘড়িতে রাত ১২টা থেকে) কতগুলো সফল request ও কত token সামলেছে। Daily limit দেওয়া থাকলে নিচে "limit ..." লেখা থাকে; সীমা পার হলে লাল হয় ও মাউস ধরলে কারণ দেখায় (তখন router ওই provider এড়িয়ে পরের model-এ যায়)।
@@ -190,6 +196,39 @@
 
 ## ৫. কাজের রেসিপি (ধাপে ধাপে)
 
+### ক-০) সবচেয়ে সহজ: Catalog থেকে provider যোগ
+1. **Catalog** পেজ → কার্ড বাছো (যেমন **Ollama Cloud** বা **Groq**) → **Get a key** দিয়ে key নাও।
+2. **Add** → key বসাও → model টিক দাও → **Add**।
+3. **Models** পেজে model-এর **⚡** চাপো। "Reachable" এলে ঠিক; না এলে কারণের নিচে সহজ ভাষার পরামর্শ আসে।
+4. Claude Code-এ `/model <model-নাম>`।
+নিজের হাতে বানানোর নিয়ম (নিচে ক) শুধু তালিকায় নেই এমন provider-এর জন্য।
+
+### প্রোটোকল: "Anthropic style" বনাম "OpenAI style"
+Claude Code Claude-এর নিজের ভাষায় কথা বলে। বেশিরভাগ কোডিং provider-এর একটা ঠিকানা আছে যেটা সেই ভাষা বোঝে (DeepSeek, Z.ai, Kimi, MiniMax, Qwen, OpenRouter, OpenCode Zen, Ollama)। কিছু ফ্রি provider শুধু **OpenAI ভাষা** জানে (Groq, Google Gemini, Cerebras, NVIDIA NIM, Mistral)। Providers → Add/Edit-এ **"Provider speaks"** থেকে বাছো। **OpenAI style** বাছলে router নিজে অনুবাদ করে: তোমার লেখা, tool call, tool-এর ফল, ছবি ও স্ট্রিমিং সব ঠিকঠাক যায়। (Claude-এর `thinking` আর cache-চিহ্ন বাদ যায়।) Base URL-এ OpenAI style হলে শেষে `/v1` থাকে (যেমন `https://api.groq.com/openai/v1`), Claude style হলে **থাকে না**, আর কোনো ক্ষেত্রেই `/v1/messages` বা `/chat/completions` লিখবে না (router নিজে জুড়ে নেয়)। ভুল ঠিকানা দিলে save-এর সময়ই কারণসহ আটকে দেয়।
+
+### Ollama: "404 path /api/v1/messages not found" কেন আর কী করবে
+- কারণ: Base URL `https://ollama.com/api` দেওয়া ছিল। router শেষে `/v1/messages` জুড়ে `https://ollama.com/api/v1/messages` ডাকে; ওটা নেই। `/api` শুধু Ollama-র নিজের ভাষার জন্য।
+- **ঠিক ঠিকানা: `https://ollama.com`** (Ollama Cloud) আর `http://localhost:11434` (নিজের কম্পিউটারে)। Ollama Cloud **Authorization: Bearer** চায় (Auth mode `bearer` বা `both`)।
+- Providers → `ollama` → Edit → Base URL ঠিক করো। এখন ভুল ঠিকানা save-ই হবে না।
+- ঠিকানা ঠিক হওয়ার পরও error এলে: **Free অ্যাকাউন্টে** শুধু কিছু "starter" model চলে এবং একবারে **১টা** request; সব model খুলতে credit কিনতে হয়। তখন অন্য model বাছো বা credit দাও। নিজের কম্পিউটারে চালালে (`ollama pull qwen3-coder`, Auth mode `none`) সীমা নেই।
+
+### ফ্রি ও কম দামি কোডিং AI: সারসংক্ষেপ (Catalog-এরই সংক্ষিপ্ত রূপ; ২০২৬-০৯-৩০ তারিখে যাচাই, সংখ্যা বদলায়)
+| ধরন | কী | ভাষা | মূল কথা |
+|---|---|---|---|
+| ফ্রি, নিজের কম্পিউটারে | Ollama local | Claude | সীমাহীন; তোমার RAM/GPU যতটা পারে |
+| ফ্রি শুরু | Ollama Cloud | Claude | ফ্রি starter ক্রেডিট, ১ request একসাথে; পরে pay-as-you-go |
+| ফ্রি শুরু | OpenRouter (`:free` model) | Claude | ২০ req/মিনিট; ৫০ req/দিন ($10 কিনলে ১০০০/দিন) |
+| ফ্রি শুরু | OpenCode Zen | Claude | কিছু model ফ্রি; key পেতে billing লাগে |
+| ফ্রি tier | Groq | OpenAI | ৩০ req/মিনিট; দিনে ১০০০ থেকে ১৪,৪০০ (model ভেদে) |
+| ফ্রি tier | Cerebras | OpenAI | ~১০ লাখ token/দিন; model তালিকা ঘনঘন বদলায় |
+| ফ্রি tier | Google Gemini | OpenAI | per-project সীমা; ফ্রিতে Google prompt ব্যবহার করতে পারে (EU/UK/EEA বাদে) |
+| ফ্রি tier | NVIDIA NIM | OpenAI | ~৪০ req/মিনিট, ফোন যাচাই |
+| ফ্রি tier | Mistral | OpenAI | Experiment tier-এ training-এ সম্মতি লাগে |
+| কম দামি | DeepSeek | Claude | Flash ≈ $0.15 in / $0.60 out (off-peak); cache-hit অনেক সস্তা |
+| কম দামি | Z.ai GLM, Kimi, MiniMax, Qwen | Claude | কম দাম; Z.ai-র Flash-এ ফ্রি tier থাকার খবর (যাচাই করে নাও) |
+Ollama Cloud-এর দাম (প্রতি ১০ লাখ token, in/out): DeepSeek V4.1 Flash $0.30/$1.20 (সপ্তাহের দিনে ১২:০০-১৮:০০ UTC-র বাইরে অর্ধেক), GLM 5.3 Flash $0.15/$0.50, GPT-OSS 120B $0.15/$0.60, Kimi K2.7 Code $0.95/$4.00, GLM 5.3 $1.40/$4.40।
+**সতর্কতা:** ফ্রি tier-এ প্রায়ই তোমার prompt provider-এর কাজে লাগে; গোপন কোড দিও না। সীমা ও দাম যেকোনো দিন বদলায়: কার্ডের "Checked" তারিখ দেখো, আর provider-এর পেজ মিলিয়ে নাও।
+
 ### ক) নতুন Provider যোগ করা (key সহ)
 উদাহরণ: OpenRouter।
 1. Providers → **Add provider**।
@@ -339,6 +378,10 @@
 | UI-তে বারবার login চাইছে | কুকি মুছছে (private window/অন্য domain) | `http://127.0.0.1:21450/ui` ঠিক এই ঠিকানায়, সাধারণ window-এ |
 | Live-এ গতি মিটার নড়ছে না | কোনো request চলছে না | Claude Code-এ কিছু চালাও |
 | Cost `$0.00` | model-এ দাম বসানো নেই | ৫(জ) |
+| Test-এ 404 "path not found" | Base URL ভুল (যেমন `https://ollama.com/api`) | ঠিকানা ঠিক করো: Ollama Cloud = `https://ollama.com`; শেষে `/v1/messages` বা ভুল `/api` নয় |
+| Test-এ 401/403 | key ভুল/মেয়াদ শেষ, বা Auth mode মেলেনি | key নতুন করে বসাও; Ollama Cloud-এ `bearer` বা `both` |
+| Test-এ 429/402 | ফ্রি কোটা/ব্যালেন্স শেষ, বা একসাথে বেশি request | provider-এর usage পেজ দেখো; অন্য model বা credit |
+| OpenAI-style provider-এ tool call/ছবি ঠিক নয় | সব provider সব ফিচার পারে না | সেই provider-এর model-এ কাজ না হলে Claude-format-এর model বাছো |
 | Model-এর ফর্মে Key ঘরটা ধূসর | Provider-এর Auth mode `none`, অথবা "Paste a new API key" খোলা আছে | `none` হলে key লাগে না; নতুন key দিতে চাইলে Auth mode বদলাও |
 | Providers-এ Today লাল | daily limit পৌঁছে গেছে | Edit → limit বাড়াও বা খালি করো, নইলে মধ্যরাত পর্যন্ত এড়ানো হবে |
 | History-র পেজ ২-এ সারি নড়ছে না | ইচ্ছাকৃত: শুধু পেজ ১ নিজে আপডেট হয় | রিফ্রেশ বাটন, বা পেজ ১-এ যাও |
`````

## Verify

```bash
cd src/web && npx tsc --noEmit && cd ../..    # no output
npm run build                                 # "built in ..."
```
Restart the router and hard-refresh the browser. Checked with a real headless Chromium on this exact code: the ⚡ test on a model behind a wrong address shows the error and the orange hint ("The address looks wrong: the router called .../api/v1/messages ..."); `/ui/catalog` shows 14 cards; adding Groq from the catalog with a pasted key created an OpenAI-style provider with its key (last 4 shown) and a daily limit of 1,000 requests; `/ui/instructions` renders and the Bangla switch works; no page errors.

After applying, do this yourself: Providers > ollama should now say `https://ollama.com` (step 3 of 13), press the ⚡ on the `deepseek-v4.1-flash` model. If it says reachable, you are done. If it names a plan or credit problem, that model needs credits on a free Ollama account: add another model from the Catalog (Ollama Cloud card lists prices) or use Ollama on your own computer.
