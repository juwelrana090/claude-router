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

প্রতিটা ফাইল শেষ হলে local AI-কে বলবে verify কমান্ডের **আসল output** দেখাতে। সব শেষে router একবার restart করবে (PM2 বা `npm run serve`) এবং browser hard-refresh দেবে।

## যাচাই (আমি কী চালিয়ে দেখেছি)

- 01–05 প্রম্পটের কোড তোমার আসল zip-এর একটা পরিষ্কার কপিতে **শুধু প্রম্পট থেকে** বসিয়ে দেখেছি: ৩৯টা অংশ সব বসেছে, ০টা ব্যর্থ, ৬৫টা source ফাইল আমার টেস্ট করা কপির সাথে হুবহু মিলেছে।
- সেই কপি build হয়েছে এবং তিনটা test suite পাস করেছে: `smoke` (proxy), `admin-smoke` (admin API), `guard-smoke` (context guard)।
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
