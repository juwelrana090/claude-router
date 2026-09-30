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