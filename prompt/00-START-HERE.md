# 00 — এখান থেকে শুরু করো (claude-router prompt pack)

এই ফাইলটা **তোমার** পড়ার জন্য, local AI-কে দেওয়ার জন্য না। বাকি ফাইলগুলো (01–06) local AI-কে এক এক করে দাও।

## কোন ফাইল কী করে, কোন ক্রমে দেবে

| ক্রম | ফাইল | কী করে |
|---|---|---|
| 1 | `01-backend.md` | SQLite database, username/password login, admin ও read-only user, request history, key ছাড়া provider (Ollama), `.env` থেকে key attach, cost হিসাব |
| 2 | `02-web-shell.md` | বাম পাশে sidebar, উপরে search, login পেজ, Users পেজ, প্রতিটা পেজের আলাদা URL |
| 3 | `03-web-live-history-usage.md` | Live পেজ (speedometer, K/M/B সংখ্যা), History পেজ, Usage-এর সংখ্যা এক রকম |
| 4 | `04-web-providers-models-settings.md` | Provider যোগ করার সময় key দেওয়া, Settings-এর ৮টা ট্যাব |
| 5 | `05-context-guard.md` | **প্রতি request-এ পুরনো tool output আবার পাঠানো বন্ধ** (নিচে ব্যাখ্যা) |
| 6 | `06-claude-code-settings.md` | Claude Code-এর settings, যাতে conversation ছোট থাকে |
| 7 | `07-routing-visibility.md` | **"glm বাছলাম, ds-flash চলল" সমস্যা:** কে উত্তর দিল, কেন সেটা দেখানো; ব্যর্থতা সামলানোর নিয়ম ঠিক করা; auto-switch চালু/বন্ধ করার সুইচ |
| 8 | `08-bangla-guide.md` | প্রজেক্টের ভেতরে থাকা বাংলা গাইড (`GUIDE-BN.md`): সব পেজ, বাটন, env, উদাহরণ |
| 9 | `09-backend-capacity.md` | **নতুন:** History-র সঠিক পেজিং (API), model-এর ফর্ম থেকে API key বসানো, provider-এর দৈনিক সীমা (আগেই অন্য provider-এ যাওয়া), ছোট context window-এর fallback সামলানো |
| 10 | `10-web-history-keys-limits-settings.md` | **নতুন:** History-র পেজ নম্বর, model ফর্মে "Paste a new API key", Providers-এ Today কলাম ও সীমা, Settings → Claude Code-এ সুন্দর JSON জেনারেটর, বাংলা গাইডের হালনাগাদ |
| 11 | `11-backend-memory.md` | **নতুন:** router-এর নিজের স্মৃতি (পুরনো কথোপকথনের সারাংশ পেছনে লেখা, SQLite-এ জমা, পরের request থেকে পুরনো মেসেজের বদলে যায়), prompt-এর ভাগ মাপা, পুরনো tool call ও বড় paste ছোট করা |
| 12 | `12-web-memory-anatomy.md` | **নতুন:** Settings → Memory ট্যাব, Usage/History-তে "prompt কোথায় যাচ্ছে", Context guard-এর নতুন সুইচ, বাংলা গাইডের হালনাগাদ |

প্রতিটা ফাইল শেষ হলে local AI-কে বলবে verify কমান্ডের **আসল output** দেখাতে। সব শেষে router একবার restart করবে (PM2 বা `npm run serve`) এবং browser hard-refresh দেবে।

## যাচাই (আমি কী চালিয়ে দেখেছি)

- 01–05, 07, 08 প্রম্পটের কোড তোমার আসল zip-এর একটা পরিষ্কার কপিতে **শুধু প্রম্পট থেকে** বসিয়ে দেখেছি: ৫৬টা অংশ সব বসেছে, ০টা ব্যর্থ, ৬৭টা ফাইল (বাংলা গাইড সহ) আমার টেস্ট করা কপির সাথে হুবহু মিলেছে।
- সেই কপি build হয়েছে এবং চারটা test suite পাস করেছে: `smoke` (proxy), `admin-smoke` (admin API), `guard-smoke` (context guard), `routing-smoke` (কে উত্তর দিল, retry, failover বন্ধ/চালু)।
- Browser (headless Chromium) দিয়ে UI চালিয়েছি: প্রথমবার admin তৈরি, login, ভুল password-এর বার্তা, refresh করলে একই পেজে থাকা, সব পেজ, Settings ট্যাব, light theme, search। কোনো page error নেই।
- **যা যাচাই করতে পারিনি:** আসল Claude Code request চলার সময় speedometer নড়ছে কি না; আর context guard তোমার আসল conversation-এ কতটা বাঁচাবে (সেটা shadow mode মাপবে)।

## তোমার প্রশ্ন: "প্রতি request-এ পুরো conversation যায় — এটা ideal না, এর সমাধান কী?"

### সত্যটা আগে
- LLM-এর নিজের **কোনো স্মৃতি নেই**। প্রতিটা request আলাদা। তাই যে কোনো tool (Claude Code, Cursor, যে কোনো API) পুরো conversation আবার পাঠায়। এটা router-এর দোষ না, LangChain বা কোনো "memory" tool দিয়েও এটা এড়ানো যায় না। "Memory" tool-গুলো আসলে যা করে: পুরনো অংশ **ছোট করে** পাঠায়। মানে সমাধান হলো: **যা পাঠানো হচ্ছে সেটা ছোট করা।**
- তোমার নিজের log বলছে (530 request): প্রতি request-এ গড়ে ~103K token যায়, তার **98.95% cache থেকে** আসে। Cache-এর দাম DeepSeek Flash-এ প্রায় ৫০ গুণ কম। তাই ~80M token-এর বিল ছিল মাত্র $0.88। মানে token **সংখ্যা** বড় দেখালেও **টাকা** ছোট। কিন্তু বড় prompt-এ উত্তর ধীর হয়, মান কমে, আর যেসব provider-এ cache নেই বা daily token limit আছে সেখানে সরাসরি ক্ষতি।

### তিন স্তরের সমাধান (প্রতিটা আলাদা কাজ করে)
1. **Claude Code আগেই compact করুক** (`06`): `CLAUDE_CODE_AUTO_COMPACT_WINDOW=120000`। তোমার log-এ prompt 168K পর্যন্ত বেড়ে তারপর কমেছে, ১০ বার। এতে সীমা ~120K-এ নামে।
2. **Router পুরনো tool output ফেলে দেবে এবং মনে রাখবে** (`05`, context guard): কোডিং agent-এর prompt-এর বড় অংশ পুরনো tool output (পড়া ফাইল, grep, command log)। Router সেগুলোকে এক লাইনের নোট দিয়ে বদলে দেয়, সবচেয়ে নতুন ৬টা রাখে। **কোনটা সাফ করেছে সেটা SQLite-এ মনে রাখে**, তাই পরের প্রতিটা request-এ ঠিক একই নোট বসে। এতে prompt-এর শুরুটা প্রতিবার হুবহু এক থাকে, আর provider-এর cache কাজ করতে থাকে। (প্রতি request-এ নতুন করে কাটলে cache প্রতিবার ভেঙে যেত।) সাফ করা হয় বিরল ব্যাচে: ৯০K পার হলে ৪৫K-তে নামায়।
3. **Session-এর মধ্যে নয়, session-এর বাইরে মনে রাখা** (`06`-এর অভ্যাস): কাজ শেষে `/r-end` (তোমার আগের কমান্ড) → `/clear` → পরদিন `/r-start`। প্রগতি ফাইলে থাকে, conversation-এ না। নতুন session ছোট থেকে শুরু হয়।

### Context guard কতটা নিরাপদ?
- শুধু পুরনো `tool_result` বদলায়। তোমার লেখা, AI-র উত্তর, thinking, system prompt, tool call কিছু ছোঁয় না। প্রতিটা tool call-এর result block থাকে (শুধু ভেতরের লেখা নোট হয়), তাই API-র কাঠামো ঠিক থাকে।
- ছবি থাকা result কখনো কাটে না। ১২০০ অক্ষরের ছোট result কাটে না।
- **ঝুঁকি:** agent পুরনো ফাইলটা আবার দরকার মনে করে আবার পড়তে পারে। তাই ডিফল্ট **shadow mode**: কিছু বদলায় না, শুধু মাপে "কত token বাঁচত"। Settings > Context guard-এ সংখ্যাটা দেখে তারপর নিজে **On** করবে। খারাপ লাগলে Off।
- গবেষণা (JetBrains, arXiv 2508.21433): এই সরল পদ্ধতি একটা কোডিং agent-এর খরচ প্রায় অর্ধেক করেছে, সমাধানের হার প্রায় সমান রেখে। এটা তাদের benchmark-এর ফল, তোমার কাজে একই হবে এমন নিশ্চয়তা না।
- আমার টেস্টে **synthetic** conversation-এ ৪৫–৭৯% ছোট হয়েছে। এটা তোমার আসল সংখ্যা না; আসল সংখ্যা shadow mode দেবে।

## "Numbers মিলছে না" — কারণ
- DeepSeek ড্যাশবোর্ডে ~79.5M, router-এ ~55M। ফারাক ~২১M token ≈ ২১৪–২৬৬টা request, যেগুলো router-এর log শুরুর (05:24 UTC) আগে হয়েছে। এটাই সবচেয়ে সম্ভাব্য ব্যাখ্যা, নিশ্চিত না। যাচাই: DeepSeek ড্যাশবোর্ডে router-এর API key দিয়ে ফিল্টার করো।
- Router-এর গণনা ঠিক ছিল; সমস্যা ছিল **সংজ্ঞা**: Live-এ "Tokens in" = নতুন + cache, Usage-এ শুধু নতুন। এখন দুই জায়গায় "Prompt tokens sent" = নতুন + cache, ভাগটা নিচে দেখানো হয়।
- Cost $0.00 দেখাত কারণ কোনো model-এ দাম বসানো ছিল না। Settings > Pricing-এ "Fill DeepSeek list prices" বাটন আছে। দামগুলো তৃতীয় পক্ষের সাইট থেকে নেওয়া (DeepSeek-এর নিজের পেজ না), তাই platform.deepseek.com/pricing-এ মিলিয়ে নিও।

## Login নিয়ে
- প্রথমবার `/ui` খুললে "admin account তৈরি করো" ফর্ম আসবে (শুধু এই কম্পিউটার থেকে)। তারপর username/password। আর "ROUTER_KEY required" popup আসবে না।
- Admin অন্য user যোগ করতে পারে (Users পেজ); সাধারণ user শুধু দেখতে পারে, বদলাতে পারে না।
- `ROUTER_KEY` এখনও Claude Code ও `statusline` স্ক্রিপ্টের জন্য দরকার। ওটা বদলিও না। তুমি `settings.json`-এ যে পাসওয়ার্ড-ধরনের ছোট key রেখেছিলে সেটা দুর্বল; লম্বা random string করে `.env` ও `settings.json` দুই জায়গায় একই মান দিও।


## "glm বাছলাম, ds-flash চলল": আমি কী পেয়েছি (07 নম্বর ফাইল)

তোমার নিজের `data/router.db` থেকে: শেষের ৬৫টা request-এর **সবগুলো** `ds-flash` উত্তর দিয়েছে, `glm` একটাও না। তার ৯টা "failover" চিহ্নিত, ৬৪, ৮৭, ১০০ সেকেন্ড পরপর।
পুরনো কোডে এটার মানে: Z.ai-র key একবার ব্যর্থ হলে router সেই key ৬০ সেকেন্ড (401/402/403 হলে ১০ মিনিট) বিশ্রামে পাঠায়, আর বিশ্রামের সময় `glm` **চুপচাপ এড়িয়ে** `ds-flash` চালায়। Claude Code ঠিকঠাক উত্তর পায়, তাই কোনো error দেখায় না। বিশ্রাম শেষে আবার glm চেষ্টা, আবার ব্যর্থ, চক্র চলতে থাকে।

**যা আমি জানি না:** Z.ai *কেন* ব্যর্থ হচ্ছে (balance? plan? limit? model id?), আর VS Code আসলে কোন নাম পাঠাচ্ছে। দুটোই এখান থেকে দেখা যায় না। 07 বসালে দুটোই স্ক্রিনে দেখা যাবে।
**দুটো পরীক্ষা:** (১) Models → `glm` → ⚡, Z.ai-র আসল উত্তর পড়ো। (২) History → নতুন সারি → Details → **Client asked for** দেখো: সেখানে `ds-flash` থাকলে VS Code-ই সেই নাম পাঠিয়েছে (Anthropic-এর নিজের GitHub রিপোর্টে আছে: VS Code সেটিংসের `claudeCode.environmentVariables`-এ `ANTHROPIC_MODEL` থাকলে extension-এর `/model` কাজ করে না, Terminal-এ করে)।


## সর্বশেষ যাচাই (09 ও 10)

- **আগের ০১–০৮ ঠিকঠাক বসেছে কি না:** তোমার শেষ zip আমার টেস্ট করা কপির সাথে মিলিয়েছি। সব ফাইল হুবহু মিলেছে, শুধু ৪টা ফাইলে স্রেফ ফাঁকা জায়গার পার্থক্য (শেষের নতুন লাইন, একটা ফাঁকা লাইন, দুই লাইনের indentation)। কোড বা আচরণে পার্থক্য নেই। তোমার কপিতে চারটা টেস্ট suite পাস করেছে।
- **09 ও 10:** তোমার আসল zip-এর ওপর শুধু প্রম্পট থেকে বসিয়েছি: ১৪টা অংশ সব বসেছে, ০টা ব্যর্থ; ৪৮টা ফাইল টেস্ট-কপির সাথে মিলেছে। সেই কপি build হয়েছে, web typecheck পরিষ্কার, পাঁচটা suite (`smoke`, `admin-smoke`, `guard-smoke`, `routing-smoke`, `capacity-smoke`) পাস করেছে।
- আসল browser (headless Chromium)-এ: ১২০ request-এর History-তে পেজ ২-এর সারি পেজ ১-এর সাথে মেলে না (overlap ০), ১২ সেকেন্ড পরেও পেজ ২ স্থির, refresh দিলে একই পেজ, `?page=99` শেষ পেজে ফেরে; model ফর্মে key বসিয়ে save করলে `ZAI_KEY_2` তৈরি হয়ে model-এ আটকে যায়; Settings → Claude Code-এ সাজানো JSON-এ আসল `statusline.mjs`-এর পথ।
- **যা যাচাই করিনি:** আসল provider (Z.ai, OpenRouter...) কেমন সাড়া দেয়; আসল Claude Code/VS Code কোন নাম পাঠায়। টেস্টগুলো নকল upstream দিয়ে।

## তোমার জন্য মনে রাখার কথা

- **"১০০% token optimize" কেউ দিতে পারে না।** যা সত্যিই করা যায়: পুরনো tool output ছাঁটা (context guard), আগে compact করা, ভুল/বড় request ব্যর্থ হওয়ার আগেই এড়ানো (09-এর window ও daily limit), আর সবকিছু মেপে দেখানো (Live, Usage, History)। Context guard এখনো **Measure only**; Settings → Context guard-এ সংখ্যা দেখে নিজে **On** করবে।
- **Auto-switch (Switch automatically)** এখন তিনভাবে কাজ করে: provider ব্যর্থ হলে, daily limit পৌঁছালে (আগেই), আর prompt ছোট-window model-এ না ধরলে। প্রতিটা সুইচ History-তে লাল "asked ..." ট্যাগসহ কারণ লেখা থাকে।
- তোমার ফোল্ডারে `pnpm-lock.yaml` আছে (প্রজেক্ট শুধু npm-এর জন্য, `.gitignore`-এও তাই লেখা)। মুছে ফেলো, নইলে pnpm আর npm মিশে আগের মতো TypeScript ভেঙে যেতে পারে।


## 11 ও 12: তোমার তিনটা দাবির উত্তর

1. **"প্রতি request-এ পুরো কথোপকথন যায়, AI যেন মনে রাখে":** এখন router-ই মনে রাখে (Router Memory)। পুরনো অংশের সারাংশ সে নিজে জমায় ও পাঠায়, পুরনো মেসেজ নয়। Claude Code-কে কিছু বদলাতে হয় না। সীমা: model-কে *কিছু* context দিতেই হয় (এটা সব AI-র নিয়ম); আমরা শুধু সেটাকে আসল মেসেজের বদলে সংক্ষিপ্ত সারাংশ করি। এক কথোপকথনের ভেতরে কাজ করে; `/clear`-এর পর নতুন কথোপকথন খালি শুরু হয়।
2. **"User prompt size কমাও":** (ক) আগে মাপা: Usage → "Where your prompt tokens go" দেখায় কোন অংশ বড়। (খ) পুরনো tool call-এর ভেতরের বড় লেখা ছোট হয় (ডিফল্ট চালু)। (গ) পুরনো মেসেজের বিশাল paste ছোট করা যায় (ডিফল্ট **বন্ধ**, কারণ তোমার নিজের লেখা বদলায়; প্রথম মেসেজ ও নতুন দুটো কখনো ছোঁয়া হয় না)। (ঘ) Memory সারাংশ।
3. **"Token optimisation + automatic switching":** Memory-র সারাংশ হয় **provider-নিরপেক্ষ**: fallback model-ও একই ছোট prompt পায়। তার ওপর 09-এর context-window মাপ প্রতিটা route-এ ফিট করে।

## 11 ও 12 যাচাই

- তোমার আসল zip-এর ওপর 09, 10, 11, 12 **শুধু প্রম্পট থেকে** বসিয়েছি: ৩১টা অংশ সব বসেছে, ব্যর্থ ০; ৫২টা ফাইল টেস্ট-কপির সাথে হুবহু মিলেছে। সেই কপি build হয়েছে, web typecheck পরিষ্কার, ছয়টা suite পাস (`memory-smoke`-এ ৪২টা check)।
- আসল browser-এ: লম্বা কথোপকথন তিনবার পাঠিয়ে Settings → Memory-তে "104K token বাঁচল, ১টা সারাংশ" ও সারাংশের সারি (View/Forget) দেখেছি; History → Details-এ prompt-এর ভাগ (tool results ৯৫%) ও memory লাইন; কোনো page error নেই।
- **যাচাই করিনি:** আসল model-এর সারাংশ কতটা ভালো হবে (টেস্টে নকল model); আসল Claude Code কাজে কতটা বাঁচবে। তাই **Memory এখন Measure only**। Settings → Memory → model বাছো, কয়েকদিন পর সংখ্যা দেখো, তারপর On।
- সস্তা model হিসেবে `ds-flash`-এর মতো দ্রুত ও সস্তাটা বাছো; মূল model দিয়ে সারাংশ করালে খরচ বাড়বে।
