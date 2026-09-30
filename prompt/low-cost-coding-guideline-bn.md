# কম খরচে সেরা কোডিং আউটপুট: গাইডলাইন

তারিখ: ২০২৬-০৯-৩০। এখানে যা "যাচাই করেছি" আর যা "অনুমান" বা "যাচাই করিনি", আলাদা করে লেখা আছে।

---

## ১. VS Code / IDE: কী সম্ভব, কী উচিত

**আপনার প্রশ্ন:** router-এর সাথে একটা চ্যাট উইন্ডো (কাজ করে দেয়, progress দেখায়), পিসিতে কোন IDE (VS Code, Cursor, Trae...) ইনস্টল আছে সেটা দেখানো, আর VS Code-এর সব extension ব্যবহার করা যাওয়া।

**ছোট উত্তর:** হ্যাঁ, সম্ভব। কিন্তু নিজে একটা IDE বানানোর চেয়ে **VS Code-কেই ব্যবহার করা এবং router-কে সব tool-এর মডেল-backend বানানো** অনেক ভালো। তিন স্তর:

| স্তর | কী | আমার মত |
|---|---|---|
| ১. VS Code-এ বিদ্যমান agent extension-কে router-এর সাথে জোড়া | Claude Code extension (আপনি এখন এটাই চালান), Cline, Kilo Code, Roo, Continue, Aider। এরা VS Code-এর ভেতরেই chat window, ফাইল বদলানো, কাজের অগ্রগতি দেয়; আর VS Code-এর **সব extension পাশাপাশি চলে** | **এটাই সবচেয়ে ভালো** |
| ২. router UI-তে "IDE ও Tools" পেজ | পিসিতে কোন IDE ইনস্টল (VS Code, Cursor, Trae, Windsurf, VSCodium) দেখানো; VS Code-এর ইনস্টল করা extension-এর তালিকা; "প্রজেক্ট VS Code-এ খোলো" বাটন; প্রতিটা tool-এর জন্য কপি-করা সেটিং | সম্ভব ও ছোট কাজ: বানাতে পারি |
| ৩. router-এর UI-র ভেতরেই নিজস্ব IDE/agent (ফাইল লেখা, কমান্ড চালানো) | সম্ভব কিন্তু বিশাল, আর ওয়েব পেজ থেকে আপনার পিসিতে কোড চালানোর নিরাপত্তা ঝুঁকি আছে। Cline/Claude Code এটা আগেই ভালো করে | **সুপারিশ করি না** |

### স্তর ১: কোন tool এখন router-এর সাথে চলে?
- **Claude Code extension (VS Code):** চলে। router Claude-এর ভাষা (`/v1/messages`) বোঝে। সেটিং একই `~/.claude/settings.json`।
- **Cline, Kilo Code, Continue, Aider:** এরা সাধারণত **OpenAI-সামঞ্জস্যপূর্ণ** ঠিকানা চায়। Cline: Settings → Providers → "OpenAI Compatible" → Base URL, API key, Model ID। Kilo Code: "OpenAI Compatible", আর কাজ শুরুর আগে `GET /v1/models` ডাকে (যাচাই করেছি: তাদের ডকুমেন্ট ও গাইডে আছে)।
  **সমস্যা:** router এখন শুধু Claude-ভাষা দেয়, OpenAI-ভাষার `/v1/chat/completions` দেয় না। তাই এই extension-গুলো এখন router ব্যবহার করতে পারে না। (কোনো extension-এ Anthropic-ভাষার custom URL থাকতে পারে: আমি যাচাই করিনি।)
  **সমাধান (বানাতে হবে):** router-এ OpenAI-ভাষার একটা "সামনের দরজা": `/v1/chat/completions` আর OpenAI-format `/v1/models`। তখন এই সব tool-ই router-এর ফ্রি/সস্তা provider, fallback, দৈনিক সীমা, Catalog সব পাবে। (উল্টো দিকের অনুবাদ, মানে OpenAI → Claude ভাষা, আমার আগেই বানানো অনুবাদ-স্তরের উল্টো; নতুন কোড লাগবে।)
- **Cursor: এড়িয়ে চলুন।** যাচাই করেছি (একাধিক লেখা ও টুল): Cursor আপনার পিসি থেকে না, **নিজের server থেকে** request পাঠায়, তাই `localhost` কাজ করে না; public HTTPS tunnel (ngrok বা Cloudflare) লাগে। Agent mode-এর payload জটিল, আর sub-agent আপনার custom URL মানে না বলে রিপোর্ট আছে। tunnel খোলা থাকলে আপনার router ইন্টারনেটে খোলা থাকে (ROUTER_KEY-ই একমাত্র পাহারা)।
- **Trae, Windsurf:** যাচাই করিনি।

### স্তর ২: "IDE দেখানো" কীভাবে সম্ভব
router আপনার পিসিতেই চলে, তাই সাধারণ ইনস্টল-পথ দেখে (Mac: `/Applications/Visual Studio Code.app`, `Cursor.app`, `Trae.app`, `Windsurf.app`; Windows: `%LOCALAPPDATA%\Programs\...`; Linux: `code`/`cursor` কমান্ড) বলতে পারে কোনটা আছে। `code --list-extensions` দিয়ে extension তালিকাও দেখাতে পারে। "প্রজেক্ট খোলো" বাটন একটা নির্দিষ্ট IDE প্রোগ্রাম চালাবে; সেটা আমি শুধু admin-কে, শুধু চেনা IDE, আর শুধু আপনার বেছে দেওয়া ফোল্ডারের জন্য সীমিত রাখব। এগুলো ডিজাইন, এখনো বানানো হয়নি।

**আমার সুপারিশ:** প্রথমে OpenAI-ভাষার সামনের দরজা + "IDE ও Tools" পেজ বানাই। তাহলে VS Code-এর ভেতর Cline/Kilo Code/Continue-এ router-এর সব ফ্রি ও সস্তা model পাবেন, VS Code-এর সব extension সহ।

---

## ২. Token optimisation: আসলে কী হচ্ছে (সবচেয়ে গুরুত্বপূর্ণ)

### যা আমি পেয়েছি
1. **এখন কিছুই বাঁচছে না।** Context guard ও Router memory ডিফল্টে "Measure only" (শুধু মাপে)। আর আপনার শেষ zip-এর `data/router.db` ০ বাইট, `logs` এ শুধু পুরনো ডেটা। তাই **আপনার আসল সাশ্রয় আমি মাপতে পারিনি**।
2. আমি একটা লম্বা সেশন (২৪০ request) router-এর মধ্য দিয়ে চালিয়ে মেপেছি (`scripts/token-benchmark.mjs`)। সেশনের আকার আপনার আসল log থেকে: প্রতি request-এ গড়ে ~২,৪০০ token বাড়ে, Claude Code ~৮০ request পরপর নিজে compact করে। Provider একটা নকল server, যেটা prompt cache-এর মতো বিল করে। **tool output বৃদ্ধির ৮০% ধরেছি: এটা অনুমান**, আপনারটা Usage → "Where your prompt tokens go"-তে দেখুন।

| কী করা হলো | token | টাকা (DeepSeek-ধরনের, cache সস্তা) | টাকা (cache নেই / quota) |
|---|---|---|---|
| কিছু না | ২১.৬M | $০.২১৬ | $৩.২৯ |
| Claude Code আগে compact (১২০K) | −২৪% | **−৭%** | −২৪% |
| Router context guard | −২৭% | **+১৩%** | −২৬% |
| Guard + Router memory | −৪১% | **+২০%** | −৩৯% |
| সব মিলিয়ে + ১২০K | −৪৫% | **+১৭%** | −৪৪% |
| Guard + Memory, cache-সস্তা model-এ, নতুন "Auto" নিয়মে | ০% | ০% | ০% |

### এর মানে
- **token কমা আর টাকা কমা এক নয়।** DeepSeek-এর মতো provider-এ cache থেকে পড়া input সাধারণ input-এর প্রায় ৫০ গুণ সস্তা। Guard/Memory prompt-এর শুরু বদলালে provider পুরো prompt একবার পুরো দামে আবার পড়ে। ফলে token কমলেও **টাকা বাড়ে**।
- **আমি আগে ভুল বলেছিলাম:** বলেছিলাম guard/memory "cache ঠিক রাখে" আর Measure only-র সংখ্যা দেখে On করতে। cache-সস্তা provider-এ এটা ভুল পরামর্শ ছিল। আর আমার প্রথম benchmark-এ আমার নিজের একটা ভুল ছিল (scenario-গুলো একই session id ব্যবহার করে একে অপরকে দূষিত করছিল); উপরের টেবিল সংশোধিত চালানোর ফল।
- **যেখানে এটা সত্যিই কাজে লাগে:** cache নেই বা quota আছে এমন provider (ফ্রি tier: Groq, Gemini, Cerebras, NVIDIA...)। সেখানে token-ই মুদ্রা; −২৬% থেকে −৪৪%।
- **তাই সংশোধন (prompt ১৫):** নতুন সেটিং "Shrink prompts for: Auto" (ডিফল্ট)। cache-সস্তা model ছোঁয়া হয় না; quota-বাঁধা, ছোট window, দাম-না-বসানো, cache-ছাড়-নেই এমন model ছাঁটা হয়। আর guard আগে প্রায় প্রতি request-এ একটা একটা করে মুছে cache ভাঙত; এখন বড় ব্যাচ না হলে কিছুই ছোঁয় না।
- **আপনার জন্য (DeepSeek) টাকা বাঁচানোর আসল উপায়:**
  1. Claude Code-এ `CLAUDE_CODE_AUTO_COMPACT_WINDOW` কমানো (টেবিলে −৭%)।
  2. অন্য কাজ শুরুর আগে `/clear`।
  3. বড় ফাইল/লগ পুরো না পড়ে টুকরো করে পড়ানো (মূল কারণ: প্রতি request-এ বৃদ্ধি কমে)।
  4. সস্তা model ডিফল্ট; বড় model শুধু কঠিন কাজে হাতে বেছে।
  5. **অন্য provider-এ fallback কমানো:** প্রতিবার অন্য provider-এ গেলে সেখানকার cache শূন্য, পুরো prompt পুরো দামে। Fallback-এর জন্য দৈনিক সীমা (আগেই সরে যাওয়া) দিন, যাতে বারবার আসা-যাওয়া না হয়।
- **আপনার নিজের সংখ্যা:** `npm run bench:tokens`; দাম/অনুপাত/tool-ভাগ বদলে চালান: `STEPS=240 TOOL_SHARE=0.6 node scripts/token-benchmark.mjs`।

### যা এখনো জানি না
আপনার আসল tool-output-ভাগ (Usage → Where your prompt tokens go), প্রতিটা আসল provider-এর cache কীভাবে বিল হয় (নকল server cache-block, মেয়াদ ইত্যাদি মডেল করে না)। ৫–৭ দিন পরে আপনার আসল Usage ও History পাঠালে আমি আবার মিলিয়ে দেখব।

---

## ৩. "সবচেয়ে ছোট AI দিয়ে সেরা কোডিং আউটপুট": ব্যবহারিক নিয়ম

1. **সত্যটা আগে:** সবচেয়ে ছোট model সবসময় সেরা আউটপুট দেয় না। কাজ করার উপায় হলো: **কাজ ছোট ও স্পষ্ট করা + ফল যাচাই করা + কঠিন অংশে বড় model হাতে বাছা।**
2. **কাজ ভাগ করো।** একটা prompt, একটা লক্ষ্য। "billing/retry.ts-এর retry লজিক ঠিক করো; সর্বোচ্চ ৩ বার; public API বদলাবে না; পরীক্ষা `npm test billing`।" এই রকম: ফাইলের নাম, সীমা, কীভাবে যাচাই হবে।
3. **ফল যাচাই নিজে নিজে হতে দাও।** test/lint/build কমান্ড দাও, যাতে ছোট model নিজের ভুল নিজেই ধরে। এতে ছোট model-ও ভালো ফল দেয়।
4. **Context পরিচ্ছন্ন রাখো।** `CLAUDE.md` ছোট; বড় ফাইল টুকরো করে পড়া; অন্য কাজে `/clear`; দিন শেষে `/r-end`, সকালে `/clear` ও `/r-start`। প্রতি request-এ যা যায় সেটাই খরচ।
5. **সাজানো routing (router-এ):**
   - ডিফল্ট: সস্তা ও ভালো (DeepSeek Flash, বা Ollama Cloud-এর GLM 5.3 Flash)।
   - Fallback: ফ্রি model, **দৈনিক সীমা সহ** (Catalog থেকে যোগ করলে নিজে বসে)।
   - কঠিন কাজ: `/model` দিয়ে হাতে বড় model (Pro, GLM 5.3, Kimi Code)।
   - গোপন বা ক্লায়েন্টের কোড: নিজের পিসির Ollama, বা যারা training করে না বলে লেখে। ফ্রি tier এড়াও।
   - Router memory-র সারাংশ: একটা ফ্রি/সস্তা model।
6. **ফ্রি tier-এর বাস্তবতা (যাচাই: মে-আগস্ট ২০২৬-এর তুলনামূলক লেখা):** ফ্রি tier-এর **প্রতি-মিনিট token সীমা** ছোট। একটা লেখায় (২০২৬-০৫-৩১ স্ন্যাপশট) Groq ছোট model-এ ~৬,০০০, Cerebras ~৩০,০০০, Mistral ~৫০,০০০ token/মিনিট; পরে বদলেছে। Claude Code-এর মতো ভারী agent-এর (system prompt + tool তালিকা + কথোপকথন) এক request-ই এর চেয়ে বড়। তাই ফ্রি tier মূলত: **ছোট প্রশ্ন, ছোট কাজ, সারাংশ লেখা, fallback**; মূল কোডিং-এর জন্য হালকা agent (যেমন Aider বা Cline ছোট context-এ) আর ছোট ফাইল।
7. **ফ্রি তালিকা বদলায়:** Catalog-এর প্রতি কার্ডে কবে যাচাই হয়েছে লেখা; ব্যবহারের আগে provider-এর পেজ মিলিয়ে নাও।
8. **মাপো, অনুমান নয়:** Usage → Where your prompt tokens go; History → Details (কে উত্তর দিল, কেন); Live → Context size; `npm run bench:tokens`।

---

## ৪. পরের ধাপ (আপনি বললে)
- **(ক)** OpenAI-ভাষার সামনের দরজা (`/v1/chat/completions`, `/v1/models`) + "IDE ও Tools" পেজ: Cline, Kilo Code, Roo, Continue, Aider আপনার router-এর সব ফ্রি ও সস্তা model ব্যবহার করবে।
- **(খ)** প্রথমে prompt ১৫ বসান (টাকা বাড়ানো বন্ধ করা), কয়েকদিন চালিয়ে আপনার Usage-এর "Where your prompt tokens go" ও History পাঠান।
