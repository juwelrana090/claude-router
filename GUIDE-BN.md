# Claude Router — বাংলা গাইড

এই ফাইলটা প্রজেক্টের ভেতরেই থাকে। এখানে সব কিছু উদাহরণসহ বলা আছে: কীভাবে চালাবে, provider ও model যোগ করবে, প্রতিটা পেজ ও বাটনের কাজ কী, Claude Code-এর `env` কেন লাগে, আর কিছু ভুল হলে কীভাবে ধরবে।

> **একটা সত্য আগে জেনে রাখো:** এই গাইডে যেসব সংখ্যা/নাম আছে (`glm`, `ds-flash`, `ZAI_KEY_1`) সেগুলো **উদাহরণ**। তোমার নিজের `routes.json` আর `.env`-এ যা আছে সেটাই আসল।

---

## ১. এটা কী এবং কীভাবে কাজ করে

Claude Code সাধারণত Anthropic-এর server-এ কথা বলে। এই প্রজেক্ট (router) তোমার কম্পিউটারে একটা ছোট server চালায়। তুমি Claude Code-কে বলো: "Anthropic-এর বদলে `http://127.0.0.1:21450`-এ কথা বলো।" তখন:

```
Claude Code / VS Code  ──►  Router (তোমার PC)  ──►  DeepSeek / Z.ai / OpenRouter / OpenCode Zen / Ollama
      মডেলের নাম বলে         নামটা দেখে ঠিক করে        আসল provider-এ পাঠায়
      (যেমন "glm")           কোন provider, কোন key
```

Router যা যা করে:
1. **নাম মেলানো:** Claude Code যে model-এর নাম পাঠায় (`glm`, `ds-flash`, `sonnet`...) সেটা তোমার Models তালিকার সাথে মেলায়।
2. **Key বাছাই:** `.env` ফাইল থেকে সঠিক API key নিয়ে provider-এ পাঠায়।
3. **Fallback:** provider ব্যর্থ হলে (balance শেষ, limit, server error) পরের model-এ চলে যায়। (এটা চাইলে বন্ধও করা যায়, ৯ নম্বর অংশ দেখো)
4. **হিসাব রাখা:** প্রতিটা request-এর token, সময়, cost একটা ডাটাবেসে জমায় (`data/router.db`)।
5. **Context guard:** পুরনো tool output ছেঁটে token বাঁচায় (৮ নম্বর অংশ)।

**Provider** = কোম্পানি/সার্ভার (DeepSeek, Z.ai)। **Model (alias)** = তুমি যে ছোট নামে ডাকো (`glm`, `ds-flash`) আর সেটা কোন provider-এর কোন আসল model-এ যাবে।

---

## ২. প্রথমবার চালু করা

দরকার: **Node 22.13 বা নতুন** (তোমার আছে Node 24)।

```bash
npm install          # প্রজেক্টের ফোল্ডারে একবার (web-এর জন্য আলাদা করে লাগে না)
npm run serve        # build করে router চালু করে
```

তারপর browser-এ `http://127.0.0.1:21450/ui` খোলো:
- **প্রথমবার:** "Create the admin account" ফর্ম আসবে। একটা username আর password (কমপক্ষে ৮ অক্ষর) দাও। এই account-ই admin। (এটা শুধু এই কম্পিউটার থেকে করা যায়।)
- **এরপর থেকে:** username/password দিয়ে sign in।

PM2 দিয়ে চালালে বদলের পর `pm2 restart <নাম>`। UI থেকে Models/Providers/Keys/Settings বদলালে restart লাগে না (router নিজেই নতুন কনফিগ পড়ে নেয়)। **কিন্তু** হাতে `.env` ফাইল এডিট করলে, বা কোড বদলে `npm run build` করলে, restart লাগে।

### `.env` ফাইল (গোপন জিনিস এখানে)

প্রজেক্টের মূল ফোল্ডারে `.env` নামে ফাইল। **এটা কাউকে দিও না, git-এ তুলো না।** উদাহরণ:

```env
ROUTER_PORT="21450"
ROUTER_KEY="এখানে-লম্বা-random-একটা-মান"     # Claude Code এই মান দিয়ে router-এ ঢোকে

DEEPSEEK_KEY_1="sk-..."
ZAI_KEY_1="..."
OPENROUTER_KEY_1="sk-or-..."
OPENCODE_ZEN_KEY_1="..."
```

- `ROUTER_KEY`: Claude Code আর স্ক্রিপ্টের জন্য "পাসওয়ার্ড"। ছোট/সহজ রেখো না (যেমন `12345678Aa!!!` দুর্বল)। লম্বা random বানাও। একই মান Claude Code-এর `ANTHROPIC_AUTH_TOKEN`-এ বসবে।
- `..._KEY_1`: প্রতিটা provider-এর API key। নামটা তুমি ঠিক করো, কিন্তু Providers পেজে ওই নামেই দেখাবে।
- Key **UI থেকেও** দেওয়া যায় (৬ নম্বর অংশ)। তখন router নিজেই `.env`-এ লিখে দেয়।

---

## ৩. Claude Code-এর `env` সেটিং (সবচেয়ে গুরুত্বপূর্ণ অংশ)

ফাইল: `~/.claude/settings.json` (Windows-এ `C:\Users\তোমার-নাম\.claude\settings.json`, Mac-এ `/Users/তোমার-নাম/.claude/settings.json`)। **VS Code extension আর terminal-এর `claude` (CLI) দুটোই এই ফাইল পড়ে**, তাই একবার ঠিক করলে দুই জায়গায় কাজ করার কথা।

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:21450",
    "ANTHROPIC_AUTH_TOKEN": "<.env-এর ROUTER_KEY-এর হুবহু একই মান>",

    "ANTHROPIC_DEFAULT_OPUS_MODEL": "ds-pro",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "glm",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "glm-fast",
    "ANTHROPIC_SMALL_FAST_MODEL": "ds-flash",

    "ANTHROPIC_CUSTOM_MODEL_OPTION": "or-b",
    "ANTHROPIC_CUSTOM_MODEL_OPTION_NAME": "or-b",
    "ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION": "OpenRouter free",

    "CLAUDE_CODE_AUTO_COMPACT_WINDOW": "120000",
    "CLAUDE_CODE_DISABLE_1M_CONTEXT": "1",

    "API_TIMEOUT_MS": "3000000",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1"
  },
  "model": "sonnet"
}
```

প্রতিটা লাইন কেন:

| লাইন | কী করে | কেন লাগে |
|---|---|---|
| `ANTHROPIC_BASE_URL` | Claude Code কোথায় কথা বলবে | Anthropic-এর বদলে তোমার router-এ পাঠানোর জন্য |
| `ANTHROPIC_AUTH_TOKEN` | router-এ ঢোকার পাসওয়ার্ড | `.env`-এর `ROUTER_KEY`-এর সাথে **হুবহু মিলতে হবে**, নইলে 401 |
| `ANTHROPIC_DEFAULT_OPUS_MODEL` | Claude Code-এর "Opus" সারিতে কোন নাম যাবে | Picker-এ Opus বাছলে router `ds-pro` নাম পায় |
| `ANTHROPIC_DEFAULT_SONNET_MODEL` | "Sonnet" সারি | এখানে `glm` |
| `ANTHROPIC_DEFAULT_HAIKU_MODEL` | "Haiku" সারি | ছোট/দ্রুত কাজের জন্য `glm-fast` |
| `ANTHROPIC_SMALL_FAST_MODEL` | Claude Code-এর নিজের ব্যাকগ্রাউন্ড কাজ (শিরোনাম, সারাংশ...) | সস্তা model দাও (`ds-flash`), যাতে বড় model খরচ না হয় |
| `ANTHROPIC_CUSTOM_MODEL_OPTION` (+`_NAME`, `_DESCRIPTION`) | Picker-এ **একটা** বাড়তি সারি | নাম/বর্ণনা শুধু দেখানোর লেখা; আসলে যে model যায় সেটা `ANTHROPIC_CUSTOM_MODEL_OPTION`-এর মান |
| `CLAUDE_CODE_AUTO_COMPACT_WINDOW` | কথোপকথন কত বড় হলে Claude Code নিজে ছোট করবে | **token বাঁচানোর সবচেয়ে বড় সুইচ।** সংখ্যা লিখবে `120000`, `120k` না |
| `CLAUDE_CODE_DISABLE_1M_CONTEXT` | "১০ লক্ষ token" মোড বন্ধ | নইলে Claude Code ভাবতে পারে জানালা বিশাল, তাই ছোট করতে দেরি করে |
| `API_TIMEOUT_MS` | কতক্ষণ অপেক্ষা করবে | ধীর provider-এর জন্য বড় রাখা |
| `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` | অপ্রয়োজনীয় ইন্টারনেট যোগাযোগ বন্ধ | router ব্যবহার করলে দরকার নেই |
| `"model": "sonnet"` (env-এর বাইরে) | শুরুতে কোন model | এখানে `sonnet` = উপরের `ANTHROPIC_DEFAULT_SONNET_MODEL` = `glm` |

### Model বদলানো: VS Code আর Terminal, দুই জায়গায়

**Terminal (CLI):**
```
/model glm           # যেকোনো alias-এর নাম লিখে সরাসরি
/model ds-flash
/model or-b
claude --model oc-free      # শুরু থেকেই
```
Picker-এ শুধু Opus/Sonnet/Haiku আর **একটা** custom সারি দেখায়। বাকিগুলো (`ds-flash`, `oc-free`...) নাম লিখে বাছতে হয়। নামে বানান ভুল হলে router ভুলে না গিয়ে **default model-এ পাঠায়** (তাই ভুল বানান = অন্য model চলবে)। History-তে "Client asked for" দেখে ধরা যায় (৭ নম্বর)।

**VS Code extension:**
- Sidebar-এর model বাছাই আর `/model` দুটোই কাজ করার কথা।
- **সাবধান:** GitHub-এ Anthropic-এর নিজের একটা রিপোর্ট আছে (issue #66100, extension 2.1.168): VS Code-এর নিজস্ব সেটিং `claudeCode.environmentVariables`-এর ভেতরে `ANTHROPIC_MODEL` থাকলে extension-এর `/model` **আর কাজ করে না**, ওই মানেই আটকে থাকে। Terminal-এ ঠিক থাকে। এটাই "VS Code-এ বদলাচ্ছে না, CLI-তে বদলাচ্ছে" লক্ষণের একটা পরিচিত কারণ।
- **নিয়ম:** (ক) `ANTHROPIC_MODEL` কোথাও রেখো না (না VS Code সেটিংসে, না `settings.json`-এ)। (খ) সব `env` শুধু `~/.claude/settings.json`-এ রাখো; VS Code-এর `claudeCode.environmentVariables` খালি রাখো। (গ) VS Code-এর `claudeCode.selectedModel` আর `settings.json`-এর `model` দুটোই আছে; কোনটা জেতে তা Anthropic-এর ডকুমেন্টে পরিষ্কার না। তাই দুটো একই রাখো (দুটোই `sonnet`, বা দুটোই `glm`)।
- সেটিং বদলে VS Code পুরোপুরি বন্ধ করে আবার খোলো (Reload Window-ও চলবে)।
- **আমি VS Code extension নিজে চালিয়ে দেখিনি।** যা নিশ্চিত: router সবসময় লিখে রাখে Claude Code কী নাম পাঠিয়েছিল (History → Details → "Client asked for")। সেটা দেখলেই বোঝা যায় দোষটা VS Code-এর পাঠানো নামে, নাকি router-এর provider ব্যর্থতায়।

---

## ৪. পেজ ও বাটন: কোথায় গেলে কী হয়

বাম পাশে sidebar (Live, History, Providers, Models, Usage, Users, Settings)। উপরে: search বক্স (`/` চাপলেই লেখা যায়, বা Ctrl+K), চলমান request-এর ছোট widget, রাত/দিন theme বদলের আইকন, তোমার নাম (ক্লিক করলে "Account and password" ও "Sign out")। প্রতিটা পেজের আলাদা URL আছে (`/ui/live`, `/ui/models`...), তাই refresh দিলে একই পেজে থাকে।

### Live (`/ui/live`)
এখন কী চলছে দেখার পেজ।
- উপরের চার কার্ড: গত ২৪ ঘণ্টার request, **Prompt tokens sent**, **Output tokens**, খরচের আন্দাজ। বড় সংখ্যা সংক্ষেপে লেখা (`54.9M` = ৫ কোটি ৪৯ লাখ)। মাউস ধরলে পুরো সংখ্যা দেখায়।
- **Speed** গোল মিটার: এখন সেকেন্ডে কত token আসছে।
- **Throughput** গ্রাফ: গত ১৫ মিনিটের গতি।
- **Context size:** তোমার prompt সাধারণত কত বড় (`p50`), বড়গুলো কত (`p90`), সবচেয়ে বড়, আর কতবার ছোট হয়েছে (Compactions)। বেশিরভাগ request সীমা ছাড়ালে হলুদ সতর্কতা।
- **Running requests:** এই মুহূর্তে যেগুলো চলছে।
- **Recent requests:** সাম্প্রতিক request। লাল **"asked glm"** ট্যাগ মানে: তুমি `glm` চেয়েছিলে কিন্তু অন্য model উত্তর দিয়েছে। ট্যাগে মাউস ধরলে কারণ দেখায়।

### History (`/ui/history`)
প্রতিটা request-এর স্থায়ী তালিকা (router restart করলেও থাকে)।
- **Search বক্স:** model/provider/session-এর নাম লিখে খোঁজো। **All models** ড্রপডাউন, **All/OK/Errors** বাটন দিয়ে ছাঁকো।
- **Context** = পুরো prompt-এর আকার। **Fresh in** = নতুন token (পুরো দামে)। **Cache read** = cache থেকে পাওয়া (অনেক সস্তা)। **Out** = model-এর লেখা।
- **Details** ক্লিক করলে ডানে ফলক খোলে:
  - **Client asked for:** Claude Code আসলে কোন নাম পাঠিয়েছিল
  - **Router chose:** সেই নাম থেকে router কোন alias ধরেছে
  - **Answered by:** আসলে কে উত্তর দিল
  - **Route taken:** ধাপে ধাপে কী হয়েছিল। `skipped` (এড়ানো হয়েছে, কারণসহ), `failed`, `retry`, `served`।
- **পেজ (Pagination):** টেবিলের নিচে ডানে পেজ নম্বর, আর "25 / page" ড্রপডাউন (25, 50, 100, 200)। পেজ আর সাইজ URL-এ থাকে (`/ui/history?page=2&size=50`), তাই refresh দিলে বা লিংক পাঠালে একই সারিগুলো আসে। সবচেয়ে নতুন request প্রথম পেজে; **শুধু প্রথম পেজ নিজে নিজে আপডেট হয়**। অন্য পেজে সারি স্থির থাকে (উপরে "page N: not auto-refreshing" লেখা আসে), নতুন করে দেখতে রিফ্রেশ বাটন। ফিল্টার বদলালে আবার পেজ ১-এ ফেরে। মোট সংখ্যা ও "1-25 of 120" লেখা থাকে।

### Catalog (`/ui/catalog`)
চেনা provider-এর তালিকা, ঠিক ঠিকানা ও সেটিংসহ। কার্ডে আছে: সংক্ষেপে কী, **ফ্রি না কম দামি**, provider-এর **ভাষা** ("Claude format" নাকি "OpenAI style (converted)"), base URL, ফ্রি সীমা, গোপনীয়তার সতর্কতা, model ও দাম (প্রতি ১০ লাখ token, USD), আর "Checked: তারিখ ও উৎস"। **Get a key** লিংক সরাসরি provider-এর key পেজে যায়। **Add** চাপলে জানালা খোলে: key বসাও, model টিক দাও (বা নিজের model id লেখো), **Add**। এক save-এ provider, key (`.env`-এ), model সব তৈরি হয়; ফ্রি provider-এ দৈনিক সীমা নিজে বসে। উপরে ডানে **How to use free or paid AI** লিংক Instructions পেজে যায়।

### Instructions (`/ui/instructions`)
ইংরেজি ও বাংলা (ডানের সুইচ)। ৬টা ভাঁজ: ৫ ধাপে শুরু; ফ্রি বনাম পেইড; কখন কোনটা; নিজে নিজে বদলে যাওয়া; token কম রাখা; সমস্যা হলে। এই গাইডের ছোট সংস্করণ।

### Providers (`/ui/providers`)
প্রতিটা সারি এক provider। **Add provider** বাটন উপরে ডানে।
**Today** কলাম: এই provider আজ (router-এর ঘড়িতে রাত ১২টা থেকে) কতগুলো সফল request ও কত token সামলেছে। Daily limit দেওয়া থাকলে নিচে "limit ..." লেখা থাকে; সীমা পার হলে লাল হয় ও মাউস ধরলে কারণ দেখায় (তখন router ওই provider এড়িয়ে পরের model-এ যায়)।
সারির ডানের আইকনগুলো: **🔍 (Keys)** key-এর তালিকা, **⚡** এই provider-এর সব model-এ ছোট test, **✎ (Edit)**, **⏻** চালু/বন্ধ (বন্ধ করলে ওই provider এড়িয়ে যায়), **🗑 (Delete)**।
"Keys 1/2 ready" মানে ২টার মধ্যে ১টা key ব্যবহারযোগ্য।

### Models (`/ui/models`)
প্রতিটা সারি এক alias। **Add model** বাটন উপরে ডানে।
- **Alias:** তোমার ডাকনাম। `default` ব্যাজ = অচেনা নামের জন্য যে model।
- **Provider / Model id:** কোন provider-এর কোন আসল model।
- **Key / pool:** নির্দিষ্ট key-এ আটকানো (pinned) হলে তার নাম, নইলে provider-এর সব key ঘুরে ঘুরে।
- **Max out:** এক উত্তরে সর্বোচ্চ কত token (ফাঁকা = সীমা নেই)।
- **Context window** (Edit-এ): model-এর আসল context আকার (provider-এর ডকুমেন্ট থেকে)। ফাঁকা = অজানা।
- **Fallbacks:** এটা ব্যর্থ হলে পরপর কোন model-এ যাবে।
- **Price in/out:** প্রতি ১০ লক্ষ token-এর দাম (খরচের আন্দাজের জন্য)।
- ডানের আইকন: **⚡** ১ token-এর test request পাঠায় (provider ঠিক আছে কি না তাৎক্ষণিক জানায়, ব্যর্থ হলে provider-এর আসল error দেখায়), **✎ Edit**, **🗑 Delete**।

### Usage (`/ui/usage`)
সময় বেছে (1h/24h/7d/30d) খরচ ও token দেখো। **Prompt size** প্যানেলে prompt কত বড়, cache কতটা কাজ করছে, কোন session সবচেয়ে বেশি খরচ করেছে। **Export CSV** ফাইল নামায়।

### Users (`/ui/users`) — শুধু admin
**Add user** দিয়ে নতুন ব্যবহারকারী। **Role:** `Admin` সব বদলাতে পারে; `User (read-only)` শুধু দেখতে পারে। আইকন: **🔑** password রিসেট, **⛔/✅** বন্ধ/চালু, **🗑** মোছা। নিজের role বদলানো বা শেষ admin-কে মোছা যায় না।

### Settings (`/ui/settings/...`), আটটা ট্যাব
- **General:** theme (Dark/Light), Project name (sidebar-এর লোগোর পাশে), "Large-prompt warning" (কত token-এর বেশি হলে সতর্কতা), history কত দিন রাখবে।
- **Routing:** (ক) **When the model you picked fails** ⇒ `Switch automatically` (ব্যর্থ হলে fallback-এ যাও) বা `Stop and show the error` (যাবে না, আসল error দেখাও), আর ব্যর্থতার আগে কতবার তাৎক্ষণিক retry। (খ) default model আর `opus/sonnet/haiku` কোথায় যাবে।
- **Pricing:** সব model-এর দাম এক নজরে; **Fill DeepSeek list prices** বাটন; peak-hour গুণক।
- **Context guard:** ৮ নম্বর অংশ।
- **Memory:** ৮(খ) নম্বর অংশ: router-এর নিজের "স্মৃতি" (পুরনো কথোপকথনের সারাংশ)।
- **Claude Code:** তোমার `~/.claude/settings.json`-এর জন্য **তৈরি JSON**। Opus/Sonnet/Haiku/background/এক্সট্রা সারির জন্য ড্রপডাউন থেকে model বাছো; নিচে সুন্দর করে সাজানো (multi-line) JSON আপনাআপনি তৈরি হয়, তাতে তোমার আসল port আর `statusline.mjs`-এর আসল পথ বসানো (Mac/Windows-এ ফাঁকা থাকা ফোল্ডারের নামও ঠিকভাবে escape করা)। উপরে-ডানে কপি বাটন। "Compact earlier" ও "Status line" সুইচ দিয়ে অংশ বাদ দেওয়া যায়। `ANTHROPIC_AUTH_TOKEN`-এ নিজের `ROUTER_KEY` বসাবে (UI কখনো আসল key দেখায় না)। ফাইলে আগে থেকে থাকা বাকি সেটিং (যেমন `permissions`) মুছো না, শুধু `env`, `model`, `statusLine` অংশ মিলিয়ে নাও। নিচে আলাদা **Status line only** বাক্সেও শুধু ওই অংশ আছে।
- **Account:** নিজের password বদলানো।
- **System:** router-এর version, চলার সময়, ফাইলের পথ, স্বাস্থ্য পরীক্ষা।
- **Data:** history কতটা জমেছে, **Clear history** (সব মুছে যাবে, users/settings থাকবে)।

---

## ৫. কাজের রেসিপি (ধাপে ধাপে)

### ক-০) সবচেয়ে সহজ: Catalog থেকে provider যোগ
1. **Catalog** পেজ → কার্ড বাছো (যেমন **Ollama Cloud** বা **Groq**) → **Get a key** দিয়ে key নাও।
2. **Add** → key বসাও → model টিক দাও → **Add**।
3. **Models** পেজে model-এর **⚡** চাপো। "Reachable" এলে ঠিক; না এলে কারণের নিচে সহজ ভাষার পরামর্শ আসে।
4. Claude Code-এ `/model <model-নাম>`।
নিজের হাতে বানানোর নিয়ম (নিচে ক) শুধু তালিকায় নেই এমন provider-এর জন্য।

### প্রোটোকল: "Anthropic style" বনাম "OpenAI style"
Claude Code Claude-এর নিজের ভাষায় কথা বলে। বেশিরভাগ কোডিং provider-এর একটা ঠিকানা আছে যেটা সেই ভাষা বোঝে (DeepSeek, Z.ai, Kimi, MiniMax, Qwen, OpenRouter, OpenCode Zen, Ollama)। কিছু ফ্রি provider শুধু **OpenAI ভাষা** জানে (Groq, Google Gemini, Cerebras, NVIDIA NIM, Mistral)। Providers → Add/Edit-এ **"Provider speaks"** থেকে বাছো। **OpenAI style** বাছলে router নিজে অনুবাদ করে: তোমার লেখা, tool call, tool-এর ফল, ছবি ও স্ট্রিমিং সব ঠিকঠাক যায়। (Claude-এর `thinking` আর cache-চিহ্ন বাদ যায়।) Base URL-এ OpenAI style হলে শেষে `/v1` থাকে (যেমন `https://api.groq.com/openai/v1`), Claude style হলে **থাকে না**, আর কোনো ক্ষেত্রেই `/v1/messages` বা `/chat/completions` লিখবে না (router নিজে জুড়ে নেয়)। ভুল ঠিকানা দিলে save-এর সময়ই কারণসহ আটকে দেয়।

### Ollama: "404 path /api/v1/messages not found" কেন আর কী করবে
- কারণ: Base URL `https://ollama.com/api` দেওয়া ছিল। router শেষে `/v1/messages` জুড়ে `https://ollama.com/api/v1/messages` ডাকে; ওটা নেই। `/api` শুধু Ollama-র নিজের ভাষার জন্য।
- **ঠিক ঠিকানা: `https://ollama.com`** (Ollama Cloud) আর `http://localhost:11434` (নিজের কম্পিউটারে)। Ollama Cloud **Authorization: Bearer** চায় (Auth mode `bearer` বা `both`)।
- Providers → `ollama` → Edit → Base URL ঠিক করো। এখন ভুল ঠিকানা save-ই হবে না।
- ঠিকানা ঠিক হওয়ার পরও error এলে: **Free অ্যাকাউন্টে** শুধু কিছু "starter" model চলে এবং একবারে **১টা** request; সব model খুলতে credit কিনতে হয়। তখন অন্য model বাছো বা credit দাও। নিজের কম্পিউটারে চালালে (`ollama pull qwen3-coder`, Auth mode `none`) সীমা নেই।

### ফ্রি ও কম দামি কোডিং AI: সারসংক্ষেপ (Catalog-এরই সংক্ষিপ্ত রূপ; ২০২৬-০৯-৩০ তারিখে যাচাই, সংখ্যা বদলায়)
| ধরন | কী | ভাষা | মূল কথা |
|---|---|---|---|
| ফ্রি, নিজের কম্পিউটারে | Ollama local | Claude | সীমাহীন; তোমার RAM/GPU যতটা পারে |
| ফ্রি শুরু | Ollama Cloud | Claude | ফ্রি starter ক্রেডিট, ১ request একসাথে; পরে pay-as-you-go |
| ফ্রি শুরু | OpenRouter (`:free` model) | Claude | ২০ req/মিনিট; ৫০ req/দিন ($10 কিনলে ১০০০/দিন) |
| ফ্রি শুরু | OpenCode Zen | Claude | কিছু model ফ্রি; key পেতে billing লাগে |
| ফ্রি tier | Groq | OpenAI | ৩০ req/মিনিট; দিনে ১০০০ থেকে ১৪,৪০০ (model ভেদে) |
| ফ্রি tier | Cerebras | OpenAI | ~১০ লাখ token/দিন; model তালিকা ঘনঘন বদলায় |
| ফ্রি tier | Google Gemini | OpenAI | per-project সীমা; ফ্রিতে Google prompt ব্যবহার করতে পারে (EU/UK/EEA বাদে) |
| ফ্রি tier | NVIDIA NIM | OpenAI | ~৪০ req/মিনিট, ফোন যাচাই |
| ফ্রি tier | Mistral | OpenAI | Experiment tier-এ training-এ সম্মতি লাগে |
| কম দামি | DeepSeek | Claude | Flash ≈ $0.15 in / $0.60 out (off-peak); cache-hit অনেক সস্তা |
| কম দামি | Z.ai GLM, Kimi, MiniMax, Qwen | Claude | কম দাম; Z.ai-র Flash-এ ফ্রি tier থাকার খবর (যাচাই করে নাও) |
Ollama Cloud-এর দাম (প্রতি ১০ লাখ token, in/out): DeepSeek V4.1 Flash $0.30/$1.20 (সপ্তাহের দিনে ১২:০০-১৮:০০ UTC-র বাইরে অর্ধেক), GLM 5.3 Flash $0.15/$0.50, GPT-OSS 120B $0.15/$0.60, Kimi K2.7 Code $0.95/$4.00, GLM 5.3 $1.40/$4.40।
**সতর্কতা:** ফ্রি tier-এ প্রায়ই তোমার prompt provider-এর কাজে লাগে; গোপন কোড দিও না। সীমা ও দাম যেকোনো দিন বদলায়: কার্ডের "Checked" তারিখ দেখো, আর provider-ের পেজ মিলিয়ে নাও।

### Command Code: কেন কাজ করেনি, আর ঠিক সেটিং
- **Command Code-এর নিয়ম (তাদের ডকুমেন্টেশন):** Base `https://api.commandcode.ai/provider/v1`, Auth `Authorization: Bearer <key>`। **Claude model শুধু `/v1/messages`-এ** (Claude-ভাষা)। **বাকি সব model (DeepSeek, GLM, Kimi, Qwen, ফ্রি model...) `/v1/chat/completions`-এ** (OpenAI-ভাষা)। ভুল endpoint-এ পাঠালে 400।
- **তোমার সেটিংয়ে দুটো ভুল ছিল:** (১) provider "Claude style" ছিল, তাই router `/provider/v1/messages` ডাকছিল, অথচ ফ্রি model Claude নয়; (২) model id `space-bunny-alpha-free` ভুল: ওটা ওয়েবপেজের লিংকের নাম। আসল id **`stealth/space-bunny-alpha`**।
- **ঠিক সেটিং:** Providers → `commandcode` → Edit: **Provider speaks = OpenAI style**, **Base URL = `https://api.commandcode.ai/provider/v1`** (শেষে `/chat/completions` লিখবে না)। Model: `stealth/space-bunny-alpha`।
- **Claude model চাইলে আলাদা provider:** Catalog → "Command Code (Claude models)" (Claude style, Base `https://api.commandcode.ai/provider`)। একই key আবার বসাতে হবে।
- **আগে থেকে শর্ত:** API ব্যবহার করতে **Go প্ল্যান ছাড়া** যেকোনো প্ল্যান (GOAT, Pro, Max, Team) বা $15-এর Provider প্ল্যান লাগে; ফ্রি model চালাতে অ্যাকাউন্টে **$1 ক্রেডিট** থাকতে হয়। Go প্ল্যানে 403 `upgrade_required` আসে।
- **সতর্কতা:** `stealth/space-bunny-alpha`-র provider prompt জমিয়ে রাখতে পারে (training-এ ব্যবহার করে না বলে) এবং এটা zero-data-retention-এ চলে না। গোপন কোড দিও না। `ling-3.1-flash:free` দিনে ৩০০ request, `ling-3.0-flash-sante:free` ১০০ request।
- **ঠিকানা ভুল দিলে:** `.../chat/completions` বা `.../v1/messages` লিখলে save হবে না; বার্তায় বলে দেয় কী লিখতে হবে।

### ক) নতুন Provider যোগ করা (key সহ)
উদাহরণ: OpenRouter।
1. Providers → **Add provider**।
2. **Name:** `openrouter` (ছোট হাতের অক্ষর, সংখ্যা, `-`)। **Base URL:** `https://openrouter.ai/api`। **Auth mode:** `bearer`।
3. **API keys** অংশে: বাম ঘরে নাম (ফাঁকা রাখলে নিজে `OPENROUTER_KEY_1` বানাবে), ডান ঘরে গোপন key। আরেকটা key লাগলে **Add another key**।
4. **Save।** key `.env`-এ লেখা হয়ে গেল; UI আর কখনো পুরো key দেখাবে না (শুধু শেষ ৪ অক্ষর)।

**Key ছাড়া provider** (নিজের কম্পিউটারের Ollama/LM Studio): **Auth mode: `none`**। তখন key ঘর আসে না। Base URL যেমন `http://127.0.0.1:11434`।

> Base URL-এর শেষে `/v1/messages` লিখবে না; router নিজেই যোগ করে। provider-এর "Anthropic-compatible" endpoint লাগে (তাদের ডকুমেন্টে খোঁজো)।

### খ) `.env`-এ আগে থেকে থাকা key যুক্ত করা
তুমি `.env`-এ `OPENCODE_KEY_1..4` লিখে রেখেছ কিন্তু UI-তে একটা দেখাচ্ছে? কারণ: provider কেবল সেইসব নাম ব্যবহার করে যেগুলো তার তালিকায় আছে।
1. Providers → `opencode` সারির **🔍 (Keys)**।
2. হলুদ বাক্সে "N keys found in .env but not used by this provider" দেখাবে।
3. **Attach** (একটা) বা **Attach all**। কাজ শেষ।

### গ) Key যোগ / বদল / মোছা
- Providers → Keys → উপরের ঘরে নাম আর মান → **Add key**। একই নামে আবার দিলে **মান বদলে যায়**।
- মোছা: সারির **🗑**। কোনো model ওই key-তে আটকানো থাকলে dialog সেটা জানাবে ও জিজ্ঞেস করবে সহ মুছবে কি না।
- key "resting" (বিশ্রামে) দেখালে ⚡ বাটন দিয়ে বিশ্রাম বাতিল করা যায়। মাউস ধরলে কারণ দেখায়।

### ঘ) নতুন Model যোগ
1. Models → **Add model**।
2. **Alias:** `my-gpt` (ছোট হাতের, সংখ্যা, `-`)। **Provider:** ড্রপডাউন থেকে। **Upstream model id:** provider-এর আসল নাম, ঠিক যেভাবে তাদের ডকুমেন্টে আছে (যেমন `deepseek-v4-flash`)। **এটা ভুল হলে provider 400/404 দেবে।**
3. **Key:** ফাঁকা রাখলে provider-এর সব key ঘুরে ব্যবহার হবে; একটা বাছলে শুধু ওটা।
4. **Max output tokens:** না দিলে সীমা নেই। **Context window:** model-এর আসল আকার দিলে ভালো (ব্যাখ্যা নিচে ৫(ট))।
5. **Fallback chain:** ব্যর্থ হলে কোন কোন model, ক্রমানুসারে। (একটা model নিজেকে বা ঘুরে নিজেকে fallback দিতে পারে না; loop ধরা পড়লে error বলে।)
6. **Price:** in / out / cache read (প্রতি ১০ লক্ষ token, USD)। DeepSeek-এর জন্য **peak** সুইচ।
7. **Save** → সারির **⚡** চাপো। "OK" এলে ঠিক।

### ঙ-১) Model-এর ফর্ম থেকেই নতুন API key বসানো
Models → **Add model** বা Edit → **Key** ঘরের নিচে **"Paste a new API key for this model"** চাপো। গোপন key বসাও; চাইলে `.env`-এর নাম দাও (ফাঁকা রাখলে নিজে `ZAI_KEY_2` ধরনের নাম বানাবে)। **Save** করলে একবারে তিনটা কাজ হয়: key `.env`-এ লেখা হয়, provider-এর তালিকায় যুক্ত হয়, আর এই model সেই key-তে আটকানো (pinned) হয়। key আর কখনো পুরোটা দেখায় না (শুধু শেষ ৪ অক্ষর)। কোনো কারণে save ব্যর্থ হলে কিছুই তৈরি হয় না। Key-বিহীন provider (Auth mode `none`)-এ এই লিংক আসে না, বদলে লেখা থাকে "needs no key"।

### ঙ) Model মোছা
Models → সারির **🗑**। অন্য model-এর fallback তালিকায় থাকলে dialog সতর্ক করবে।

### চ) Provider মোছা
Providers → **🗑**। তার model থাকলে dialog জানাবে; "সহ মুছুন" বললে model-গুলোও যায়। `.env`-এর key-র মান মোছে না, শুধু তালিকা থেকে সরে।

### ছ-১) দৈনিক সীমা (daily limit) দিয়ে আগেই অন্য provider-এ যাওয়া
কিছু provider-এর দিনে request বা token সীমা আছে (যেমন OpenRouter-এর free model)। Providers → Edit → **Daily request limit** বা **Daily token budget** দাও (ফাঁকা = সীমা নেই)। আজকের সংখ্যা সীমায় পৌঁছালে router **provider-কে প্রশ্নই করে না**, সরাসরি fallback-এ যায়, আর History → Details-এ লেখা থাকে: `daily request limit reached (50 of 50 today)`। Token গণনা = নতুন input + cache read + cache write + output। শুধু সফল request গোনা হয়; রাত ১২টায় (router-এর ঘড়ি) আবার শূন্য। সীমা বাড়ালে বা খালি করলে সঙ্গে সঙ্গে আবার চালু। একসাথে অনেক request গেলে সামান্য বেশি যেতে পারে।

### ছ) Fallback সাজানো: উদাহরণ
"glm সবসময় glm-এই চলুক, ব্যর্থ হলে চুপচাপ অন্যটায় যেও না": Models → `glm` → **Fallback chain** খালি করো, অথবা Settings → Routing → **Stop and show the error**।
"glm ব্যর্থ হলে আগে glm-fast, তারপর ds-flash": `glm`-এর Fallback chain-এ ক্রমানুসারে `glm-fast`, `ds-flash`। (fallback এক স্তরের: `glm`-এর তালিকাই শুধু দেখা হয়, `glm-fast`-এর নিজের তালিকা আবার দেখা হয় না।)

### ট) Fallback model-এর context window ছোট হলে (token বাঁচানো ও নিরাপত্তা)
ধরো `glm`-এ ১২০K token-এর কথোপকথন চলছে, আর glm ব্যর্থ হয়ে `or-b` (ছোট window)-এ যাচ্ছে। না সামলালে provider "prompt too long" বলে ফেরাত। তাই `or-b`-এর Edit-এ **Context window** দাও (যেমন `128000`)। তখন:
1. prompt window-এর ৯০%-এর মধ্যে হলে কিছুই বদলায় না।
2. বড় হলে router আগে **পুরনো tool output ছেঁটে** ফিটে আনে (শুধু এই route-এর জন্য; মূল model অপরিবর্তিত)। **কী ছেঁটেছে সেটা মনে রাখে**, তাই এই route-এ পরের request-এও একই লেখা যায় ও cache কাজ করে।
3. তাতেও না ধরলে ওই route **এড়িয়ে** পরের fallback-এ যায়, আর History-তে কারণ লেখা থাকে।
আকার না জানা থাকলে ফাঁকা রাখো, তখন আগের মতোই চলে।

### জ) দাম বসানো (cost $0.00 হটাতে)
Settings → Pricing → **Fill DeepSeek list prices** (দাম না-থাকা DeepSeek model-এ বসায়) অথবা Models → Edit → Price। দামগুলো তৃতীয় পক্ষের তথ্যে বসানো; provider-এর নিজের দামের পাতা মিলিয়ে নিও।

### ঝ) নতুন user যোগ
Users → **Add user** → username, password, role। পরের জন `User (read-only)` হলে শুধু দেখতে পারবে।

---

## ৬. "glm বাছলাম, কিন্তু ds-flash চলল": কীভাবে ধরবে

**আগে জেনে রাখো, router কী করে:** `glm` ব্যর্থ হলে (যেমন Z.ai-এর balance/limit-এর সমস্যা) router সেই key-কে কিছুক্ষণ **বিশ্রামে** পাঠায় (`resting`)। বিশ্রামের সময় `glm` **এড়িয়ে** সরাসরি fallback (`ds-flash`) চালায়। Claude Code উত্তর পায়, তাই কোনো error দেখায় না। আগে এই পুরো ব্যাপারটা কোথাও দেখানো হতো না।

### ধাপ ১: আসল কারণ দেখো (৩০ সেকেন্ড)
1. Models → `glm`-এর **⚡** চাপো। Z.ai-র আসল উত্তর দেখাবে (যেমন `HTTP 429 ... Insufficient balance` বা `403 ...`)। এটা পড়লেই বোঝা যায় সমস্যা Z.ai account-এ কি না (balance, plan, limit, ভুল model id)।
2. History → সাম্প্রতিক সারিতে লাল **"asked glm"** ট্যাগ থাকলে **Details** খোলো। **Route taken**-এ `glm ... skipped/failed` লাইনে কারণ লেখা।
3. Providers → `zai` → Keys → key "resting" ট্যাগে মাউস ধরো: শেষ error লেখা।

### ধাপ ২: কারণ অনুযায়ী সমাধান
| History/Details-এ কী দেখছ | মানে | কী করবে |
|---|---|---|
| `Client asked for: ds-flash` (তুমি glm বেছেছিলে) | Claude Code-ই `ds-flash` নাম পাঠিয়েছে; router-এর দোষ না | ৩ নম্বর অংশ: VS Code-এ `ANTHROPIC_MODEL` আছে কি না, `claudeCode.selectedModel` আর `model` মেলে কি না, `ANTHROPIC_SMALL_FAST_MODEL` ভুল করে মূল model হয়েছে কি না দেখো |
| `Client asked for: glm` + `asked glm` ট্যাগ + কারণে "balance/quota/plan" | Z.ai account সমস্যা | Z.ai-তে balance/plan ঠিক করো; ঠিক না হওয়া পর্যন্ত fallback চলবে |
| কারণে "Rate limit" / 429 | একসাথে বেশি request | router নিজেই ২ বার তাৎক্ষণিক retry করে; বারবার হলে Settings → Routing-এ retry বাড়াও বা model/plan-এর limit দেখো |
| কারণে "unknown model"/400/404 (Failover-এ যায় না) | `Upstream model id` ভুল | Models → `glm` → Edit → Upstream model id provider-এর ডকুমেন্টের সাথে মেলাও |
| `resolvedVia: default` | অচেনা নাম পাঠানো হয়েছে, router default model-এ দিয়েছে | নামটা Models-এর কোনো alias-এর সাথে মেলাও বা `env`-এর নাম ঠিক করো |

### ধাপ ৩: তুমি কী চাও ঠিক করো
- **"সবসময় আমার বাছা model-ই চলুক":** Settings → Routing → **Stop and show the error**। তখন ব্যর্থ হলে Claude Code-এ provider-এর নিজের error দেখাবে।
- **"কাজ থামবে না, দরকারে অন্যটা":** `Switch automatically` রাখো, আর মাঝে মাঝে History-তে লাল "asked ..." ট্যাগ আছে কি না দেখো।
- ⚠️ Fallback মানে অন্য provider-এ প্রথম request পুরো দামে ও ধীরে (cache নেই), তাই বারবার আসা-যাওয়া (flapping) খরচ বাড়ায়।

---

## ৭. router-এর ভেতরের দুটো নতুন নিয়ম (কেন এখন আগের চেয়ে ভালো)

1. **আগে:** একটা 429 এলেই পুরো key ৬০ সেকেন্ডের জন্য বাদ, আর 401/402/403 হলে ১০ মিনিট। বাদ থাকা সময়ে সব request চুপচাপ fallback-এ।
   **এখন:** দুই ধরনের ব্যর্থতা আলাদা করে দেখে।
   - *সাময়িক* (rate limit, overload, network, 5xx): আগে ১-২ সেকেন্ড অপেক্ষা করে একই key-তে আবার চেষ্টা (ডিফল্ট ২ বার)। তাতেও না হলে ছোট বিশ্রাম (৮ সেকেন্ড, বারবার হলে দ্বিগুণ হয়ে সর্বোচ্চ ৫ মিনিট)।
   - *স্থায়ী* (balance/quota/permission, 401/402/403): retry না করে সরাসরি ১০ মিনিট বিশ্রাম।
2. **সব সময় কারণ লেখা থাকে:** কোন model কেন এড়ানো হলো, provider-এর error-এর সারাংশ (key-এর মতো লেখা আপনাআপনি `[redacted]` হয়ে যায়), সবই History → Details-এ।

Response header-ও থাকে (`curl -i` দিয়ে দেখা যায়): `x-router-asked`, `x-router-served`, `x-router-failover`।

---

## ৮. Token বাঁচানো (কেন প্রতি request-এ পুরো কথোপকথন যায়)

Model-এর নিজের **কোনো স্মৃতি নেই**। তাই Claude Code প্রতিবার পুরো কথোপকথন আবার পাঠায়। এটা সব AI-এর নিয়ম, router বদলাতে পারে না। যা করা যায়: **যা পাঠানো হচ্ছে সেটা ছোট করা।**

তোমার আসল log (৫৩০ request) বলেছে: গড় prompt ~১০৩K token; তার ~৯৯% cache থেকে (সস্তা)। তাই টাকা কম, কিন্তু সংখ্যা বড় আর উত্তর ধীর।

তিন স্তরে ছোট করো:
1. **`CLAUDE_CODE_AUTO_COMPACT_WINDOW=120000`** (ওপরের `env`-এ আছে): Claude Code নিজে আগে ছোট করে।
2. **Context guard** (Settings → Context guard): router **পুরনো tool output** (পড়া ফাইল, grep, লগ) এক লাইনের নোটে বদলায়, নতুন ৬টা রাখে। **কোনটা বদলেছে router মনে রাখে**, তাই পরের request-এও ঠিক একই নোট বসে; ফলে prompt-এর শুরু প্রতিবার এক থাকে ও cache ভাঙে না।
   - `Off` / `Measure only` (ডিফল্ট: কিছু বদলায় না, শুধু মাপে কত বাঁচত) / `On`।
   - প্রথমে Measure only-তে কয়েকদিন চালাও, সংখ্যা দেখো, তারপর `On`। ঝুঁকি: agent কখনো পুরনো ফাইল আবার পড়তে পারে।
3. **অভ্যাস:** অন্য কাজ শুরু করলে `/clear`; বড় কাজ শেষে `/compact`; দিন শেষে `/r-end`, পরদিন `/clear` তারপর `/r-start`।

### ৮(০) সত্যটা আগে: token কমা আর টাকা কমা এক জিনিস নয়
আমি `scripts/token-benchmark.mjs` দিয়ে একটা লম্বা কোডিং সেশন (২৪০ request, তোমার আসল log-এর বৃদ্ধির হার: প্রতি request-এ গড়ে ~২,৪০০ token, ৮০ request পরপর Claude Code নিজে compact করে) router-এর মধ্য দিয়ে চালিয়ে মেপেছি। Provider-এর বদলে একটা নকল server, যেটা **prompt cache-এর মতো** আচরণ করে (prompt-এর শুরুর যে অংশ আগের request-এর সাথে হুবহু মেলে সেটা "cache read", বাকিটা "fresh")। ফল (tool output = বৃদ্ধির ৮০% ধরে; এটা **অনুমান**, তোমারটা Usage → "Where your prompt tokens go"-তে দেখো):

| কী করা হলো | token | টাকা: DeepSeek-ধরনের (cache সস্তা) | টাকা: cache নেই / quota-বাঁধা |
|---|---|---|---|
| কিছু না (Claude Code ১৬৫K-তে compact) | ২১.৬M | $০.২১৬ | $৩.২৯ |
| Claude Code আগে compact (১২০K) | −২৪% | **−৭%** | −২৪% |
| Router Context guard চালু | −২৭% | **+১৩%** | −২৬% |
| Guard + Router Memory | −৪১% | **+২০%** | −৩৯% |
| সবকিছু + ১২০K | −৪৫% | **+১৭%** | −৪৪% |
| Guard + Memory, তবে cache-সস্তা model-এ (Auto) | ০% (ছোঁয়া হয়নি) | ০% | ০% |
(tool output ৫০% ধরলে: guard −১৫% token কিন্তু +২৪% টাকা; memory −৪৩% token কিন্তু +৩৮% টাকা।)

**কেন টাকা বাড়ে:** DeepSeek-এর মতো provider-এ cache-থেকে-পড়া input সাধারণ input-এর প্রায় ৫০ গুণ সস্তা। Guard বা Memory prompt-এর **শুরুর অংশ** বদলালে provider পুরো prompt একবার **পুরো দামে** আবার পড়ে। তাই token কমলেও (সস্তা) cache-পড়া কমার সাশ্রয় ছোট, আর পুরো দামে আবার-পড়ার খরচ বড়। **যেখানে cache নেই বা quota আছে** (ফ্রি tier, Groq, Gemini...) সেখানে token-ই আসল মুদ্রা, আর কমানো সরাসরি লাভ।

**তাই ডিফল্ট এখন "Auto"** (Settings → Context guard → "Where to shrink prompts"): router শুধু সেখানে ছাঁটে যেখানে লাভ: (১) দৈনিক সীমা দেওয়া provider, (২) ছোট context window-এর model, (৩) দাম বসানো নেই এমন model (ফ্রি/অজানা ধরা হয়), (৪) cache-ছাড় নেই এমন model। যেসব model-এ cache ৫০%-এর বেশি সস্তা (যেমন দাম বসানো DeepSeek) সেগুলো ছোঁয়া হয় না। **তাই Settings → Pricing-এ দাম বসিয়ে রাখো।** সবখানে জোর করে চালাতে চাইলে "Every provider"।
আরও একটা নিয়ম: আগে guard প্রায় প্রতি request-এ একটা একটা করে পুরনো result মুছে prompt-এর শুরু বদলাত (cache ভেঙে যেত)। এখন মোট যা মোছা যাবে সেটা (উঁচু-নিচু সীমার ফাঁকের অর্ধেকের) কম হলে কিছুই ছোঁয় না।
**DeepSeek-এ টাকা বাঁচানোর আসল উপায়:** Claude Code-এ `CLAUDE_CODE_AUTO_COMPACT_WINDOW` কমানো (উপরে B), অন্য কাজে `/clear`, বড় ফাইল/লগ পুরোটা না পড়া (টুকরো করে পড়া), সস্তা model, আর **fallback-এ অন্য provider-এ যাওয়া কমানো** (প্রতিবার অন্য provider-এ গেলে সেখানকার cache শূন্য, পুরো prompt পুরো দামে)। নিজের provider-এর দামে মাপতে: `npm run bench:tokens`।

### ৮(ক) আরও ছোট করার দুটো সুইচ (Settings → Context guard)
- **Also shrink old tool calls** (ডিফল্ট চালু): পুরনো tool output ছাঁটার সময় ওই tool-এর **ডাকের** ভেতরের বড় লেখাও ছোট হয়। যেমন আগের `Write`-এ পুরো ফাইলের লেখা ছিল, এখন থাকে `[router: 9000 characters cleared ...]`; ফাইলের পথ ও বাকি ঘর থাকে।
- **Shrink big pasted text in old messages** (ডিফল্ট **বন্ধ**, কারণ এটা তোমার নিজের লেখা বদলায়): তোমার পুরনো মেসেজে বিশাল paste (log, ফাইল) থাকলে প্রথম ১৫০০ আর শেষ ৫০০ অক্ষর থাকে। **তোমার প্রথম মেসেজ আর সবচেয়ে নতুন দুটো কখনো ছোঁয়া হয় না।** "A paste counts as big above" ঘরে সীমা (ডিফল্ট ১২,০০০ অক্ষর)।

### ৮(খ) Router Memory: router নিজে মনে রাখে (Settings → Memory)
- **কেন:** model-এর স্মৃতি নেই, তাই Claude Code পুরো কথোপকথন আবার পাঠায়। Router memory তার হয়ে মনে রাখে: কথোপকথন লম্বা হলে একটা **সস্তা model** (যেটা তুমি বাছো) **পুরনো মেসেজগুলোর সারাংশ** লেখে। সেটা SQLite-এ জমা থাকে, আর পরের request থেকে পুরনো মেসেজের **বদলে** ওই সারাংশ যায়। দুটো সারাংশের মাঝে প্রতিবার হুবহু একই লেখা যায়। **মনে রাখো (৮(০)):** এটা token কমায়, কিন্তু cache-সস্তা provider-এ টাকা বাড়াতে পারে, তাই "Auto" নিয়মে সেখানে চলে না।
- **অপেক্ষা করতে হয় না:** যে request সীমা পার করে সেটা আগের মতোই যায়। সারাংশ **পেছনে** লেখা হয়, পরের request থেকে কাজে লাগে।
- **নিরাপত্তা:** তোমার আসল প্রথম অনুরোধ হুবহু সারাংশের ভেতরে থাকে। সবচেয়ে নতুন মেসেজগুলো কখনো সারাংশ হয় না। কথোপকথনের শুরু বদলে গেলে (যেমন Claude Code নিজে `/compact` করলে) পুরনো সারাংশ আর লাগানো হয় না। সারাংশ-model ব্যর্থ হলে তোমার request অপরিবর্তিত যায়, আর router ৫ মিনিট পরে আবার চেষ্টা করে।
- **খরচ ও ঝুঁকি:** প্রতিটা সারাংশে একবার ওই model-এর খরচ (History-তে "router memory summary" নামে দেখা যায়; কিছু লুকানো নেই), আর সারাংশ থেকে ছোটখাটো খুঁটিনাটি হারাতে পারে। তাই আগে **Measure only**।
- **ধাপ:** Settings → Memory → **Model that writes the summaries** বাছো (সস্তা, দ্রুতটা, যেমন `ds-flash`) → **Mode: Measure only** → কয়েকদিন পর "Tokens it would remove" দেখো → ঠিক লাগলে **On**। "Start summarising above" (ডিফল্ট ৮০,০০০) ও "Aim to get down to" (৩৫,০০০) বদলানো যায়।
- **"What the router remembers now"** তালিকায় প্রতিটা কথোপকথনের সারাংশ আছে: **View** দিয়ে পড়তে পারো, **Forget** দিয়ে মুছলে পরের request-এ আবার পুরো কথোপকথন যায়।
- **সীমা:** এটা এক কথোপকথনের ভেতরে কাজ করে। `/clear` দিলে নতুন কথোপকথন খালি শুরু হয় (এটাই ঠিক)। এক session থেকে আরেক session-এ স্মৃতি নিতে চাইলে প্রজেক্টের ফাইল (`CLAUDE.md`, `.claude/memory`, `/r-end`) ব্যবহার করো।

### ৮(গ) তোমার prompt-এর টোকেন কোথায় যাচ্ছে (ছোট করার আগে দেখো)
- **Usage → "Where your prompt tokens go":** গত কয়েকশো request-এর গড়, ভাগে ভাগে: Tool results, System prompt, Tool definitions, Tool calls, AI text, তোমার মেসেজ, Thinking, ছবি।
- **History → কোনো সারির Details → "What this prompt was made of":** ওই এক request-এর ভাগ।
- সবচেয়ে বড় ফালিটাই ছোট করার জায়গা। সাধারণত Tool results সবচেয়ে বড় হয়; তখন Context guard আর Memory কাজে লাগে। System prompt বা Tool definitions বড় হলে সেটা Claude Code-এর নিজের (কম প্লাগইন/MCP রাখলে কমে); router সেগুলো বদলায় না।

সফল হলো কি না বুঝবে: Live → Context size-এ `p50` আর `p90` আগের ১০৬K/১৫৬K-এর চেয়ে কমছে কি না।

---

## ৯. সাধারণ সমস্যা ও সমাধান

| লক্ষণ | সম্ভাব্য কারণ | কী করবে |
|---|---|---|
| Claude Code-এ `401` | `ANTHROPIC_AUTH_TOKEN` আর `.env`-এর `ROUTER_KEY` মেলেনি | দুটো হুবহু এক করো |
| `Unknown model ...` | নাম `Models`-এ নেই (default model-ও নেই) | Models-এ alias যোগ করো বা নাম ঠিক করো |
| Models-এ "0/1 ready" | ওই key `.env`-এ ফাঁকা/নেই | Keys → key দাও, বা `.env` ঠিক করো |
| Provider "NO KEY" | key-ই দেওয়া হয়নি | Keys থেকে দাও; কেবল local হলে Auth mode `none` |
| `ollama` model "0/0 ready" | Auth mode `both`, কিন্তু key নেই | Providers → ollama → Edit → Auth mode `none` |
| `.env`-এ আছে কিন্তু UI-তে নেই | provider তালিকায় যুক্ত করা হয়নি | ৫(খ): Keys → Attach |
| Provider-এর তালিকায় আছে কিন্তু `.env`-এ নেই (যেমন `ZAI_KEY_2`) | নিষ্ক্রিয় ঘর; model যদি নির্দিষ্ট key-এ আটকানো থাকে তাহলে কখনো ব্যবহার হয় না | দরকার না হলে ঠিক আছে; নইলে Keys-এ মান দাও |
| Claude Code-এ `Autocompact is thrashing` | বড় ফাইল/output বারবার context ভরিয়ে দিচ্ছে | বড় ফাইল টুকরো করে পড়ো; `/compact` বা `/clear`; Context guard `On` |
| UI-তে বারবার login চাইছে | কুকি মুছছে (private window/অন্য domain) | `http://127.0.0.1:21450/ui` ঠিক এই ঠিকানায়, সাধারণ window-এ |
| Live-এ গতি মিটার নড়ছে না | কোনো request চলছে না | Claude Code-এ কিছু চালাও |
| Cost `$0.00` | model-এ দাম বসানো নেই | ৫(জ) |
| Test-এ 404 "path not found" | Base URL ভুল (যেমন `https://ollama.com/api`) | ঠিকানা ঠিক করো: Ollama Cloud = `https://ollama.com`; শেষে `/v1/messages` বা ভুল `/api` নয় |
| Test-এ 400 "Wrong endpoint for model" | Claude model OpenAI-style provider-এ, বা অন্য model Claude-style provider-এ | "Provider speaks" মেলাও; Command Code-এ Claude আলাদা provider |
| Test-এ 403 `upgrade_required` | প্ল্যানে API নেই (Command Code Go) | প্ল্যান বদলাও বা অন্য provider |
| Test-এ 401/403 | key ভুল/মেয়াদ শেষ, বা Auth mode মেলেনি | key নতুন করে বসাও; Ollama Cloud-এ `bearer` বা `both` |
| Test-এ 429/402 | ফ্রি কোটা/ব্যালেন্স শেষ, বা একসাথে বেশি request | provider-এর usage পেজ দেখো; অন্য model বা credit |
| OpenAI-style provider-এ tool call/ছবি ঠিক নয় | সব provider সব ফিচার পারে না | সেই provider-এর model-এ কাজ না হলে Claude-format-এর model বাছো |
| Model-এর ফর্মে Key ঘরটা ধূসর | Provider-এর Auth mode `none`, অথবা "Paste a new API key" খোলা আছে | `none` হলে key লাগে না; নতুন key দিতে চাইলে Auth mode বদলাও |
| Providers-এ Today লাল | daily limit পৌঁছে গেছে | Edit → limit বাড়াও বা খালি করো, নইলে মধ্যরাত পর্যন্ত এড়ানো হবে |
| History-র পেজ ২-এ সারি নড়ছে না | ইচ্ছাকৃত: শুধু পেজ ১ নিজে আপডেট হয় | রিফ্রেশ বাটন, বা পেজ ১-এ যাও |
| Memory On করতে গেলে "choose the model..." | সারাংশ লেখার model বাছা হয়নি | Settings → Memory → model বাছো, তারপর On |
| Memory On, কিন্তু কিছু বদলাচ্ছে না | prompt এখনো "Start summarising above" সীমার নিচে, বা সারাংশ-model ব্যর্থ (৫ মিনিট পর আবার চেষ্টা) | Live/Usage-এ আকার দেখো; router log-এ `[MEMORY]` লাইন; সীমা কমাও |
| Fallback-এ গিয়ে "does not fit the ... window" | ছোট-window model-এ prompt ধরছে না | ওটা এড়িয়ে পরেরটা চলে; সমাধান: বড় window-এর model আগে রাখো বা `/compact` |
| OpenRouter model 404 "ZDR" | OpenRouter অ্যাকাউন্টের privacy সেটিং (Zero Data Retention) ওই model-কে আটকাচ্ছে | openrouter.ai/settings/privacy-তে ZDR সীমা বদলাও বা অন্য model নাও |

---

## ১০. গুরুত্বপূর্ণ ফাইল কোথায় কী

| ফাইল/ফোল্ডার | কী |
|---|---|
| `.env` | সব গোপন key, `ROUTER_KEY`, port (**git-এ তুলো না**) |
| `routes.json` | provider ও model-এর তালিকা, fallback, দাম, `defaultModel`, `aliases`। UI থেকে বদলালে router নিজে লেখে (পুরনো কপি `backups/`-এ থাকে) |
| `data/router.db` | users, session, history, সেটিংস (**git-এ তুলো না**) |
| `logs/usage.jsonl` | পুরনো usage লগ (প্রথমবার history-তে ঢোকানো হয়) |
| `scripts/statusline.mjs` | Claude Code-এর নিচের status বারে model, সময়, token দেখানোর স্ক্রিপ্ট |
| `scripts/*-smoke.mjs` | স্বয়ংক্রিয় টেস্ট (`node scripts/smoke.mjs`, `admin-smoke.mjs`, `guard-smoke.mjs`, `routing-smoke.mjs`) |
| `GUIDE-BN.md` | এই গাইড |

### শব্দার্থ
- **Alias:** তোমার দেওয়া model-এর ডাকনাম। **Upstream model id:** provider-এর আসল model নাম।
- **Fallback:** ব্যর্থ হলে পরের model। **Resting (বিশ্রাম):** ব্যর্থ key-কে কিছুক্ষণ না-ব্যবহার করা।
- **Pinned key:** model যেটা শুধু একটা নির্দিষ্ট key-তে আটকানো। **Pool:** provider-এর সব key ঘুরিয়ে ব্যবহার।
- **Cache read:** আগে পাঠানো prompt-এর মিলে যাওয়া অংশ; provider এটা খুব কম দামে ধরে।
- **Context / Prompt:** এক request-এ পাঠানো পুরো কথোপকথনের আকার (token-এ)।
- **Compaction:** Claude Code নিজে কথোপকথন সংক্ষেপ করে ছোট করা।
