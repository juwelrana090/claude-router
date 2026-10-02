# 16 — Fix Command Code (provider, model id, catalog) and make address errors say what to type

**Run after 01–15 (your current tree).** Local only: one config repair script, three source files, one test file, one guide.

## Why Command Code does not work

Command Code's own docs (commandcode.ai/docs/provider) say: the address is `https://api.commandcode.ai/provider/v1`, auth is `Authorization: Bearer <key>`, **Claude models are served only on `/v1/messages`** (Claude format) and **every other model only on `/v1/chat/completions`** (OpenAI format); a model sent to the wrong endpoint gets a 400. Your `routes.json` has two mistakes:

1. The provider `commandcode` is Claude format (no `protocol`) with address `https://api.commandcode.ai/provider`, so the router calls `/provider/v1/messages`. The Command Code card in your Catalog (added to your tree after prompt 15) was also Claude format, with the free non-Claude models on it. Non-Claude models cannot work there.
2. The model `cc-sonnet` uses the id `space-bunny-alpha-free`. That is the anchor name of the deal on their pricing page, not a model id. The documented id of the free model is `stealth/space-bunny-alpha`.

I reproduced this against a mock of those documented rules with your exact `routes.json`: the router calls `/provider/v1/messages` with `space-bunny-alpha-free` and gets HTTP 400. With the repaired file it calls `/provider/v1/chat/completions` with `stealth/space-bunny-alpha` and Bearer auth and gets HTTP 200.

The error you pasted (`400 baseURL: remove /v1/messages or /chat/completions ...`) was the address check refusing an address you typed that ends in `/v1/messages` or `/chat/completions`, copied from their endpoint table. The check is right but the message did not say what to type; it now does.

What this step does:

1. **`scripts/fix-commandcode.mjs`**: a one-time repair of `routes.json` (backup `routes.json.bak`, idempotent): provider `commandcode` gets `"protocol": "openai"` and address `https://api.commandcode.ai/provider/v1`; model `cc-sonnet` gets the id `stealth/space-bunny-alpha`. It changes exactly those three things and nothing else (checked with a diff on your real file).
2. **Catalog**: your Command Code card becomes the OpenAI-format card (address `/provider/v1`, the free models, DeepSeek/GLM/Kimi/MiniMax/Qwen/GPT with the prices from Command Code's pricing page, plan and privacy notes) and a second card for the Claude models (Claude format, address `/provider`), because Claude and non-Claude models need different formats and so different providers.
3. **Address errors**: a pasted `.../chat/completions` now says "set Provider speaks to OpenAI style and use https://.../v1"; a pasted `.../v1/messages` says which address to use.
4. **Test hints**: a 400 "wrong endpoint" explains Claude-format versus OpenAI-format; a 403 `upgrade_required` explains that the plan has no API access.

What I could not verify: your Command Code plan. Their docs say every plan except Go has API access and that the free models need $1 of credit in the account. If, after this fix, the test button answers 403 `upgrade_required`, the plan has no API access. The model ids on the catalog card were not re-checked one by one (the card says so).

## How to work (read this first)

- This file is **complete**. Do not open, search or read any other file or folder. For a diff, open only that one file.
- Apply each diff from the repo root with `git apply --ignore-whitespace --whitespace=nowarn <file.patch>` (save the block to a `.patch` file first) or edit by hand: `-` lines removed, `+` lines added, the rest is context. If a hunk already looks like the `+` version, skip it and say so.
- Existing files use Windows line endings (CRLF); keep them. No refactors, no renames, no formatting changes.
- Never print, log or commit `.env` values. Everything in this prompt runs on this computer only.
- Finish by running the verification commands and paste their **real output**.

## Steps

### Step 1 — Create this new file

### `scripts/fix-commandcode.mjs` — NEW file

```js
// One-time config repair for the Command Code provider. Run from the repo root:  node scripts/fix-commandcode.mjs
// What it does to routes.json (a backup is written to routes.json.bak first), and nothing else:
//   provider "commandcode": protocol -> "openai", baseURL -> https://api.commandcode.ai/provider/v1
//   model "cc-sonnet" (if it still has the wrong id "space-bunny-alpha-free"): model -> stealth/space-bunny-alpha
// Why: Command Code serves Claude models only on /v1/messages and every other model on /v1/chat/completions,
// and the free model's real id is stealth/space-bunny-alpha. It is safe to run twice.
import fs from "node:fs";
import path from "node:path";

const file = path.resolve(process.cwd(), "routes.json");
const raw = fs.readFileSync(file, "utf8");
const cfg = JSON.parse(raw);
const p = cfg.providers?.commandcode;
if (!p) {
  console.log('No provider named "commandcode" in routes.json: nothing to do.');
  process.exit(0);
}
fs.writeFileSync(`${file}.bak`, raw);
const changes = [];
if (p.protocol !== "openai") {
  p.protocol = "openai";
  changes.push('provider commandcode: protocol -> "openai"');
}
if (p.baseURL !== "https://api.commandcode.ai/provider/v1") {
  changes.push(
    `provider commandcode: baseURL ${p.baseURL} -> https://api.commandcode.ai/provider/v1`,
  );
  p.baseURL = "https://api.commandcode.ai/provider/v1";
}
for (const [alias, m] of Object.entries(cfg.models ?? {})) {
  if (m.provider === "commandcode" && m.model === "space-bunny-alpha-free") {
    m.model = "stealth/space-bunny-alpha";
    changes.push(
      `model ${alias}: model space-bunny-alpha-free -> stealth/space-bunny-alpha`,
    );
  }
}
const indent = /^\{\r?\n( +)"/.exec(raw)?.[1]?.length ?? 2;
const eol = raw.includes("\r\n") ? "\r\n" : "\n";
fs.writeFileSync(
  file,
  JSON.stringify(cfg, null, indent).replace(/\n/g, eol) +
    (/\n$/.test(raw) ? eol : ""),
);
console.log(
  changes.length
    ? `Changed ${changes.length} thing(s):\n- ${changes.join("\n- ")}\nBackup: routes.json.bak`
    : "Already correct: nothing changed.",
);
```

### Step 2 — Run it once from the repo root

```bash
node scripts/fix-commandcode.mjs
```

Expected output: `Changed 3 thing(s):` followed by the three lines (protocol, baseURL, model id). Running it again prints `Already correct: nothing changed.` The router reloads `routes.json` by itself.

### Step 3 — Apply these diffs

### `src/config.ts` — address error says what to type

```diff
--- a/src/config.ts
+++ b/src/config.ts
@@ -331,8 +331,13 @@
   let u: URL;
   try { u = new URL(baseURL); } catch { return null; }
   const path = u.pathname.replace(/\/+$/, "");
-  if (/\/v1\/messages$/.test(path) || /\/chat\/completions$/.test(path)) {
-    return "remove /v1/messages or /chat/completions from the end: the router adds the final part itself";
+  if (/\/chat\/completions$/.test(path)) {
+    const fixed = `${u.origin}${path.replace(/\/chat\/completions$/, "")}`;
+    return `remove /chat/completions from the end and set "Provider speaks" to OpenAI style: use ${fixed} (the router adds the final part itself)`;
+  }
+  if (/\/v1\/messages$/.test(path)) {
+    const fixed = `${u.origin}${path.replace(/\/v1\/messages$/, "")}`;
+    return `remove /v1/messages from the end: use ${fixed} (the router adds the final part itself)`;
   }
   if (protocol === "anthropic" && /\/v1$/.test(path)) {
     return "remove /v1 from the end: for an Anthropic-style provider the router adds /v1/messages itself";
```

### `src/admin.ts` — hints for wrong endpoint and plan without API access

```diff
--- a/src/admin.ts
+++ b/src/admin.ts
@@ -123,6 +123,8 @@
   if (status === 404 && /path|not found|404|no route/i.test(detail)) {
     return `The address looks wrong: the router called ${url} and the server does not have it. Fix the Base URL in Providers > Edit (do not add /v1/messages yourself; for Ollama cloud use https://ollama.com).`;
   }
+  if (status === 403 && /upgrade/i.test(detail)) return "The provider says your plan has no API access (Command Code: every plan except Go has it). Upgrade the plan or use another provider.";
+  if (status === 400 && /endpoint|\/messages|chat\/completions|wrong/i.test(detail)) return "Wrong format for this model: some gateways (Command Code, for example) serve Claude models only in Claude format (/v1/messages) and every other model only in OpenAI format (/chat/completions). Make \"Provider speaks\" match the model, or add a second provider for the other format.";
   if (status === 401 || status === 403) return "The provider refused the key. Check that the key is the right one for this provider and not expired, and that Auth mode matches (Ollama cloud needs bearer or both).";
   if (status === 402 || status === 429) return "The provider says no balance, no free credits left, or too many requests. Check the provider's usage page; free plans often allow only some models.";
   if (status === 400 && /model/i.test(detail)) return "The provider does not know this model id. Copy the exact id from the provider's model list.";
```

### `src/catalog.ts` — Command Code: OpenAI-format card + Claude card

```diff
--- a/src/catalog.ts
+++ b/src/catalog.ts
@@ -96,30 +96,49 @@
     verified: "2026-09-30: model ids seen in your own routes.json and in OpenCode Zen listings; confirm in the dashboard",
   },
   {
-    id: "commandcode", name: "CommandCode", tier: "freemium", protocol: "anthropic",
-    baseURL: "https://api.commandcode.ai/provider", auth: "bearer", keyUrl: "https://commandcode.ai/settings/keys", pricingUrl: "https://commandcode.ai/pricing",
-    summary: "One key for ~50 models (Claude, GPT, Gemini, DeepSeek, GLM, Kimi, Qwen ...) paid with credits, plus a few free models.",
-    limits: "Credit-based: a free tier for solo developers, paid plans from $1/mo ($10 credits) up to the $15/mo Provider API plan (pay-as-you-go top-ups, zero markup). Models marked free cost no credits while the preview or capacity lasts.",
-    steps: ["Create an account and an API key at commandcode.ai/settings/keys (the same key works for their CLI and the API).", "Add the provider here.", "Copy model ids from commandcode.ai/docs/reference/cli/models (matching is case-insensitive; the part after / alone also works)."],
+    id: "commandcode", name: "Command Code (open and OpenAI models)", tier: "freemium", protocol: "openai",
+    baseURL: "https://api.commandcode.ai/provider/v1", auth: "bearer", keyUrl: "https://commandcode.ai/settings/keys", pricingUrl: "https://commandcode.ai/docs/resources/pricing-limits",
+    summary: "One key for about 90 models, including several free ones. This card is for the open and OpenAI-format models (DeepSeek, GLM, Kimi, Qwen, MiniMax, GPT, Gemini and the free ones). Claude models are on the next card.",
+    limits: "API access needs a plan other than Go (GOAT $10/mo, Pro $20/mo, Max, Team) or the pay-as-you-go Provider plan ($15/mo with $15 of usage). It is the same key the Command Code CLI uses. Free models cost no credits, but the account needs $1 of credit to start. ling-3.1-flash:free allows 300 requests a day and ling-3.0-flash-sante:free 100 a day, per account.",
+    privacy: "Free and stealth models can run under their own provider's terms: the Space Bunny Alpha provider may keep prompts (it says it does not train on them) and it is not served under zero data retention. Keep private code away from free and stealth models.",
+    steps: [
+      "Create an API key at commandcode.ai/settings/keys. Check in Studio > Billing that your plan has API access (every plan except Go) and that the account has at least $1 of credit.",
+      "Add the provider here. The address is https://api.commandcode.ai/provider/v1 and the format is OpenAI style: the router adds /chat/completions.",
+      "Pick models. A model that is refused with 'wrong endpoint' is a Claude model: use the Command Code (Claude models) card for those.",
+    ],
+    models: [
+      { id: "stealth/space-bunny-alpha", label: "Space Bunny Alpha (free)", free: true, coding: true, note: "Free while the stealth preview lasts. The provider may retain prompts." },
+      { id: "poolside/laguna-s-2.1-free", label: "Laguna S 2.1 (free)", free: true, coding: true, note: "Free while capacity lasts." },
+      { id: "inclusionai/ling-3.1-flash:free", label: "Ling 3.1 Flash (free, 300 requests a day)", free: true },
+      { id: "inclusionai/ling-3.0-flash-sante:free", label: "Ling 3.0 Flash Sante (free, 100 requests a day)", free: true },
+      { id: "deepseek/deepseek-v4.1-flash", label: "DeepSeek V4.1 Flash", coding: true, price: { in: 0.15, out: 0.60, cacheRead: 0.003, peak: true }, note: "Off-peak price; double during DeepSeek's peak hours." },
+      { id: "deepseek/deepseek-v4-flash", label: "DeepSeek V4 Flash", coding: true, price: { in: 0.15, out: 0.60, cacheRead: 0.003, peak: true } },
+      { id: "z-ai/glm-5.3-flash", label: "GLM 5.3 Flash", coding: true, price: { in: 0.15, out: 0.50, cacheRead: 0.03 } },
+      { id: "moonshotai/Kimi-K2.7-Code", label: "Kimi K2.7 Code", coding: true, price: { in: 0.95, out: 4.00, cacheRead: 0.19 } },
+      { id: "MiniMaxAI/MiniMax-M3", label: "MiniMax M3", coding: true, price: { in: 0.30, out: 1.20, cacheRead: 0.06 }, note: "Price shown includes a 50% deal that can end." },
+      { id: "Qwen/Qwen3.7-Plus", label: "Qwen 3.7 Plus", coding: true, price: { in: 0.40, out: 1.60, cacheRead: 0.08 } },
+      { id: "gpt-5.6-luna", label: "GPT-5.6 Luna", price: { in: 0.20, out: 1.20, cacheRead: 0.02 } },
+    ],
+    customModelHint: "Copy the exact id from commandcode.ai/docs/reference/cli/models. Claude ids (claude-...) do not work here: they are served on the Claude format card.",
+    verified: "2026-10-01: commandcode.ai/docs/provider (endpoints, Bearer auth, Claude models only on /v1/messages, everything else on /v1/chat/completions) and commandcode.ai/docs/resources/pricing-limits (plans, free models, prices). Model ids were not re-checked one by one: if one is refused, copy the current id from the models page.",
+  },
+  {
+    id: "commandcode-claude", name: "Command Code (Claude models)", tier: "freemium", protocol: "anthropic",
+    baseURL: "https://api.commandcode.ai/provider", auth: "bearer", keyUrl: "https://commandcode.ai/settings/keys", pricingUrl: "https://commandcode.ai/docs/resources/pricing-limits",
+    summary: "The same Command Code key, for Claude models only. They are served only on the Claude-format address, which is why they need their own provider.",
+    limits: "Same plan rules as the other Command Code card (API access on every plan except Go; the $15 Provider plan is pay-as-you-go). Claude models cost credits: there is no free Claude model.",
+    steps: [
+      "Use the same Command Code API key (paste it again here, it is stored under its own name).",
+      "Add the provider. The address is https://api.commandcode.ai/provider: the router adds /v1/messages.",
+      "Only Claude models work on this provider. Anything else belongs on the other Command Code card.",
+    ],
     models: [
-      { id: "inclusionai/ling-3.1-flash:free", label: "Ling 3.1 Flash (free)", free: true },
-      { id: "inclusionai/ling-3.0-flash-sante:free", label: "Ling 3.0 Flash Sante (free)", free: true },
-      { id: "poolside/laguna-s-2.1-free", label: "Laguna S 2.1 (free)", free: true, coding: true },
-      { id: "stealth/space-bunny-alpha", label: "Space Bunny Alpha (free)", free: true, note: "Free while the stealth preview lasts." },
-      { id: "stealth/pixel-canary", label: "Pixel Canary (free)", free: true, note: "Free while the stealth preview lasts." },
-      { id: "deepseek/deepseek-v4-flash", label: "DeepSeek V4 Flash", coding: true, note: "The API's default model." },
-      { id: "deepseek/deepseek-v4.1-flash", label: "DeepSeek V4.1 Flash", coding: true },
-      { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", coding: true, note: "The example model in CommandCode's own API curl." },
-      { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", coding: true },
-      { id: "claude-opus-5-5", label: "Claude Opus 5.5", coding: true },
-      { id: "z-ai/glm-5.3-flash", label: "GLM 5.3 Flash", coding: true },
-      { id: "moonshotai/Kimi-K2.7-Code", label: "Kimi K2.7 Code", coding: true },
-      { id: "MiniMaxAI/MiniMax-M3", label: "MiniMax M3", coding: true },
-      { id: "Qwen/Qwen3.7-Plus", label: "Qwen 3.7 Plus", coding: true },
-      { id: "gpt-5.6-luna", label: "GPT-5.6 Luna", note: "Premium closed model, costs credits." },
+      { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", coding: true, price: { in: 3, out: 15, cacheRead: 0.30 } },
+      { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", coding: true, price: { in: 2, out: 10, cacheRead: 0.20 } },
+      { id: "claude-opus-5-5", label: "Claude Opus 5.5", coding: true, price: { in: 4, out: 20, cacheRead: 0.20 } },
     ],
-    customModelHint: "Copy a current id from commandcode.ai/docs/reference/cli/models. Per-token prices are not published; the credit plans are on their pricing page.",
-    verified: "2026-10-01: commandcode.ai/docs/provider (address https://api.commandcode.ai/provider/v1/messages, Bearer auth, key page) and /docs/reference/cli/models (model ids and free marks); plans from /pricing. No per-token prices published (credit-based).",
+    customModelHint: "Claude ids as on commandcode.ai/docs/reference/cli/models.",
+    verified: "2026-10-01: commandcode.ai/docs/provider (Claude models only on /v1/messages) and commandcode.ai/docs/resources/pricing-limits (prices). Model ids were not re-checked one by one.",
   },
   {
     id: "zai", name: "Z.ai (GLM)", tier: "cheap", protocol: "anthropic",
```

### `scripts/providers-smoke.mjs` — tests for the cards, the address messages and the hints

```diff
--- a/scripts/providers-smoke.mjs
+++ b/scripts/providers-smoke.mjs
@@ -58,6 +58,16 @@
   let data = ""; req.on("data", (c) => (data += c));
   req.on("end", () => {
     lastAnth = { url: req.url, auth: req.headers.authorization ?? null, xkey: req.headers["x-api-key"] ?? null };
+    let asked = "";
+    try { asked = JSON.parse(data || "{}").model ?? ""; } catch { /* not json */ }
+    if (asked === "wrong-endpoint") {
+      res.writeHead(400, { "content-type": "application/json" });
+      return res.end('{"error":{"type":"invalid_request_error","message":"Wrong endpoint for model wrong-endpoint: non-Anthropic models are served on /v1/chat/completions"}}');
+    }
+    if (asked === "needs-upgrade") {
+      res.writeHead(403, { "content-type": "application/json" });
+      return res.end('{"error":{"type":"permission_error","message":"upgrade_required: you are on the Go plan, the only plan without API access"}}');
+    }
     res.writeHead(200, { "content-type": "application/json" });
     res.end(JSON.stringify({ type: "message", content: [{ type: "text", text: "from anthropic-style" }], usage: { input_tokens: 10, output_tokens: 5 } }));
   });
@@ -204,6 +214,28 @@
 pr = await admin("/admin/catalog/add", { method: "POST", body: JSON.stringify({ version: await version(), id: "gemini", models: [] }) });
 t("no model chosen -> clear error", pr.status === 400 && /choose at least one model/.test(await pr.text()));
 const after = (await (await admin("/admin/models")).json()).models.map((m) => m.alias);
+// ---------- 7b. Command Code: the card, the address message, the hints
+{
+  const cc = cat.entries.find((e) => e.id === "commandcode");
+  const ccl = cat.entries.find((e) => e.id === "commandcode-claude");
+  t("Command Code card (open models) is OpenAI style on /provider/v1 with Bearer auth", cc && cc.protocol === "openai" && cc.baseURL === "https://api.commandcode.ai/provider/v1" && cc.auth === "bearer");
+  t("... it lists the docs-confirmed free model id and no Claude models (those are only served on /v1/messages)", cc.models.some((m) => m.id === "stealth/space-bunny-alpha" && m.free) && cc.models.every((m) => !/^claude-/i.test(m.id)));
+  t("Command Code Claude card is Claude format on /provider and lists only Claude ids", ccl && ccl.protocol === "anthropic" && ccl.baseURL === "https://api.commandcode.ai/provider" && ccl.models.length > 0 && ccl.models.every((m) => /^claude-/.test(m.id)));
+  const vv = await version();
+  const pe = await admin("/admin/providers/groq", { method: "PUT", body: JSON.stringify({ version: vv, baseURL: "https://api.commandcode.ai/provider/v1/chat/completions" }) });
+  const pet = await pe.text();
+  t("a pasted .../chat/completions address is refused and the message says what to type", pe.status === 400 && /https:\/\/api\.commandcode\.ai\/provider\/v1/.test(pet) && /OpenAI style/.test(pet), pet.slice(0, 200));
+  const pm = await admin("/admin/providers/anth", { method: "PUT", body: JSON.stringify({ version: vv, baseURL: "https://api.commandcode.ai/provider/v1/messages" }) });
+  t("a pasted .../v1/messages address is refused with the corrected address", pm.status === 400 && /use https:\/\/api\.commandcode\.ai\/provider /.test(await pm.text()));
+  let mv = await version();
+  await admin("/admin/models", { method: "POST", body: JSON.stringify({ version: mv, alias: "wrongep", provider: "anth", model: "wrong-endpoint", key: "ANTH_KEY_1" }) });
+  mv = await version();
+  await admin("/admin/models", { method: "POST", body: JSON.stringify({ version: mv, alias: "needsup", provider: "anth", model: "needs-upgrade", key: "ANTH_KEY_1" }) });
+  const hw = await (await admin("/admin/models/wrongep/test", { method: "POST", body: JSON.stringify({ confirm: true }) })).json();
+  t("test on a model behind the wrong endpoint: hint explains Claude-only vs OpenAI format", hw.ok === false && /Provider speaks/.test(hw.hint ?? "") && /Claude models only in Claude format/.test(hw.hint ?? ""), hw.hint?.slice(0, 80));
+  const hu = await (await admin("/admin/models/needsup/test", { method: "POST", body: JSON.stringify({ confirm: true }) })).json();
+  t("test on a plan without API access: hint says the plan has no API access", hu.ok === false && /no API access/.test(hu.hint ?? ""), hu.hint?.slice(0, 80));
+}
 t("failed adds left nothing behind", !after.includes("x") && !(await (await admin("/admin/providers")).json()).providers.some((p) => p.name === "gemini"));

 // ---------- 8. a free OpenAI-style model can be the one that writes the memory summaries
```

### `GUIDE-BN.md` — Bangla guide: Command Code

```diff
--- a/GUIDE-BN.md
+++ b/GUIDE-BN.md
@@ -229,6 +229,15 @@
 Ollama Cloud-এর দাম (প্রতি ১০ লাখ token, in/out): DeepSeek V4.1 Flash $0.30/$1.20 (সপ্তাহের দিনে ১২:০০-১৮:০০ UTC-র বাইরে অর্ধেক), GLM 5.3 Flash $0.15/$0.50, GPT-OSS 120B $0.15/$0.60, Kimi K2.7 Code $0.95/$4.00, GLM 5.3 $1.40/$4.40।
 **সতর্কতা:** ফ্রি tier-এ প্রায়ই তোমার prompt provider-এর কাজে লাগে; গোপন কোড দিও না। সীমা ও দাম যেকোনো দিন বদলায়: কার্ডের "Checked" তারিখ দেখো, আর provider-এর পেজ মিলিয়ে নাও।

+### Command Code: কেন কাজ করেনি, আর ঠিক সেটিং
+- **Command Code-এর নিয়ম (তাদের ডকুমেন্টেশন):** Base `https://api.commandcode.ai/provider/v1`, Auth `Authorization: Bearer <key>`। **Claude model শুধু `/v1/messages`-এ** (Claude-ভাষা)। **বাকি সব model (DeepSeek, GLM, Kimi, Qwen, ফ্রি model...) `/v1/chat/completions`-এ** (OpenAI-ভাষা)। ভুল endpoint-এ পাঠালে 400।
+- **তোমার সেটিংয়ে দুটো ভুল ছিল:** (১) provider "Claude style" ছিল, তাই router `/provider/v1/messages` ডাকছিল, অথচ ফ্রি model Claude নয়; (২) model id `space-bunny-alpha-free` ভুল: ওটা ওয়েবপেজের লিংকের নাম। আসল id **`stealth/space-bunny-alpha`**।
+- **ঠিক সেটিং:** Providers → `commandcode` → Edit: **Provider speaks = OpenAI style**, **Base URL = `https://api.commandcode.ai/provider/v1`** (শেষে `/chat/completions` লিখবে না)। Model: `stealth/space-bunny-alpha`।
+- **Claude model চাইলে আলাদা provider:** Catalog → "Command Code (Claude models)" (Claude style, Base `https://api.commandcode.ai/provider`)। একই key আবার বসাতে হবে।
+- **আগে থেকে শর্ত:** API ব্যবহার করতে **Go প্ল্যান ছাড়া** যেকোনো প্ল্যান (GOAT, Pro, Max, Team) বা $15-এর Provider প্ল্যান লাগে; ফ্রি model চালাতে অ্যাকাউন্টে **$1 ক্রেডিট** থাকতে হয়। Go প্ল্যানে 403 `upgrade_required` আসে।
+- **সতর্কতা:** `stealth/space-bunny-alpha`-র provider prompt জমিয়ে রাখতে পারে (training-এ ব্যবহার করে না বলে) এবং এটা zero-data-retention-এ চলে না। গোপন কোড দিও না। `ling-3.1-flash:free` দিনে ৩০০ request, `ling-3.0-flash-sante:free` ১০০ request।
+- **ঠিকানা ভুল দিলে:** `.../chat/completions` বা `.../v1/messages` লিখলে save হবে না; বার্তায় বলে দেয় কী লিখতে হবে।
+
 ### ক) নতুন Provider যোগ করা (key সহ)
 উদাহরণ: OpenRouter।
 1. Providers → **Add provider**।
@@ -398,6 +407,8 @@
 | Live-এ গতি মিটার নড়ছে না | কোনো request চলছে না | Claude Code-এ কিছু চালাও |
 | Cost `$0.00` | model-এ দাম বসানো নেই | ৫(জ) |
 | Test-এ 404 "path not found" | Base URL ভুল (যেমন `https://ollama.com/api`) | ঠিকানা ঠিক করো: Ollama Cloud = `https://ollama.com`; শেষে `/v1/messages` বা ভুল `/api` নয় |
+| Test-এ 400 "Wrong endpoint for model" | Claude model OpenAI-style provider-এ, বা অন্য model Claude-style provider-এ | "Provider speaks" মেলাও; Command Code-এ Claude আলাদা provider |
+| Test-এ 403 `upgrade_required` | প্ল্যানে API নেই (Command Code Go) | প্ল্যান বদলাও বা অন্য provider |
 | Test-এ 401/403 | key ভুল/মেয়াদ শেষ, বা Auth mode মেলেনি | key নতুন করে বসাও; Ollama Cloud-এ `bearer` বা `both` |
 | Test-এ 429/402 | ফ্রি কোটা/ব্যালেন্স শেষ, বা একসাথে বেশি request | provider-এর usage পেজ দেখো; অন্য model বা credit |
 | OpenAI-style provider-এ tool call/ছবি ঠিক নয় | সব provider সব ফিচার পারে না | সেই provider-এর model-এ কাজ না হলে Claude-format-এর model বাছো |
```

## Verify

```bash
npx tsc --noEmit                    # no output
cd src/web && npx tsc --noEmit && cd ../..    # no output
npm run build                       # built
node scripts/smoke.mjs && node scripts/admin-smoke.mjs && node scripts/guard-smoke.mjs && node scripts/routing-smoke.mjs && node scripts/capacity-smoke.mjs && node scripts/memory-smoke.mjs && node scripts/providers-smoke.mjs && node scripts/optimise-smoke.mjs   # ALL PASSED x8
```

The new checks in `providers-smoke.mjs`: the open-models card is OpenAI format on `/provider/v1` with Bearer auth, lists the free model id and no Claude ids; the Claude card is Claude format on `/provider` with only Claude ids; a pasted `.../chat/completions` is refused with the corrected address and "OpenAI style"; a pasted `.../v1/messages` is refused with the corrected address; the test button on a model behind the wrong endpoint shows the Claude-versus-OpenAI hint; a 403 `upgrade_required` shows the no-API-access hint.

Then restart nothing: open the router UI > Models > the `cc-sonnet` row > the thunderbolt test button. It should say Reachable. (If it says 403 upgrade_required the plan has no API access; if it says unknown model, copy the current id from commandcode.ai/docs/reference/cli/models into the model's Upstream model id.)
