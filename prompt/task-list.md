You are working on a claude-router deployment on AlmaLinux 10. The user wants to use ONLY free-tier providers. Completely remove ALL paid providers, ALL DeepSeek web bridge references, and ALL CLIProxyAPI traces from the project.

TASKS:

1. Open routes.json.
   - Remove these provider entries entirely: "deepseek", "zai", "openrouter" (paid version), "opencode", "commandcode", "gemini", "cliproxyapi", and any "ds2api-web" or similar DeepSeek-web bridge entry.
   - Keep ONLY free providers: "openrouter-free", "groq-free", "ollama-cloud" (add them if missing, using the config from the previous steps).
   - Update "routing.aliases", "routing.fallbacks", and "defaultModel" so they only reference the free providers.
2. Open .env.
   - Remove any keys that belong to paid providers or DeepSeek web bridges (e.g., DEEPSEEK*KEY*_, ZAI*KEY*_, COMMANDCODE*KEY*\*, CLIPROXYAPI_KEY, DS2API_WEB_KEY, etc.).
   - Keep only OPENROUTER_API_KEY, GROQ_API_KEY, OLLAMA_CLOUD_API_KEY (or whichever free keys the user has).
   - Do NOT print or log any secret values.
3. Search the entire repository for mentions of "cliproxyapi", "CLIProxyAPI", "ds2api", "DeepSeek web", "chat.deepseek.com", "8317", or "ds-web".
   - Remove or neutralize each reference in docs (README.md, Notes.md, GUIDE-BN.md) and code (src/catalog.ts, src/admin.ts, scripts/) so no dead links or stale instructions remain.
4. Run `npm run check` (tsc --noEmit) and fix any TypeScript errors caused by removed provider references (e.g., catalog entries, admin route defaults).
5. Output a summary of every file changed, every provider removed, and every key removed from .env.

CONSTRAINTS:

- Do NOT add any paid provider back.
- Do NOT add any browser-automation or web-session bridge.
- Keep the router bound to 127.0.0.1; do not change security settings.

আপনার অনুরোধ অনুযায়ী, আমি `JinBeiCN/DeepSeek-Free-API` রিপোজিটরিটি ভালোভাবে পর্যালোচনা করেছি। এই রিপোজিটরিটি একটি Python/FastAPI-ভিত্তিক প্রক্সি যা DeepSeek ওয়েবের `userToken` এবং PoW (Proof-of-Work) চ্যালেঞ্জ ব্যবহার করে স্ট্যান্ডার্ড API তৈরি করে। মূল বিষয় হলো, এটি `chat.deepseek.com`-এর ইন্টারনাল এন্ডপয়েন্ট (`/api/v0/chat/completion`) এবং `DeepSeekHashV1` অ্যালগরিদম ব্যবহার করে, যা WASM মডিউলের মাধ্যমে সমাধান করা হয়。

আপনার `claude-router`-এ সরাসরি এই ফিচারটি ইমপ্লিমেন্ট করার জন্য নিচের প্রম্পটটি আপনার লোকাল AI-কে দেওয়া যাবে। এই প্রম্পটটি থার্ড-পার্টি ব্রিজ ব্যবহার না করে, আপনার কোডবেসের ভেতরেই DeepSeek ওয়েব-টু-API ফাংশনালিটি তৈরি করার নির্দেশনা দেয়।

---

### আপনার লোকাল AI-এর জন্য প্রম্পট

````
You are a senior TypeScript/Node.js engineer working on the `claude-router` project (a local Anthropic-compatible AI gateway built with Node.js stdlib only, zero runtime dependencies). Your task is to implement a NATIVE, first-party DeepSeek Web-to-API feature directly inside the router. Do NOT use any third-party bridge (no ds2api, no CLIProxyAPI, no external Python/Go binaries). All logic must live inside the existing `claude-router` codebase.

## OBJECTIVE
Add a new provider protocol called `"deepseek-web"` to `claude-router` that allows Claude Code (or any Anthropic-compatible client) to consume a free `chat.deepseek.com` web account as a model provider. The feature must handle:
- Extracting and using a `userToken` from environment variables.
- Solving the DeepSeek PoW (Proof-of-Work) challenge (DeepSeekHashV1) automatically.
- Creating and managing chat sessions on DeepSeek's backend.
- Translating Anthropic Messages API requests to DeepSeek's internal web API format.
- Streaming SSE responses back in Anthropic format.
- Supporting tool calling (if the model supports it) via prompt injection or native translation.

## ARCHITECTURE CONSTRAINTS
1. The implementation must be a new module (e.g., `src/deepseek-web.ts`) that exports an adapter similar to the existing `src/openai.ts`.
2. The adapter must be selected via `protocol: "deepseek-web"` in `routes.json` (extend the config types in `src/config.ts`).
3. Reuse the existing routing pipeline: the new protocol should integrate into `src/index.ts` `proxyMessages` alongside the `isOpenAI` branch.
4. The PoW solver must be pure Node.js. You may use the built-in `node:crypto` module for hashing, but for the WASM-based DeepSeekHashV1 algorithm, you must either:
   - Implement a pure JavaScript version of the algorithm (if feasible), OR
   - Load a pre-compiled WASM binary from a local file (e.g., `src/deepseek-pow.wasm`) and execute it using Node.js `WebAssembly` API. Do NOT fetch the WASM from the internet at runtime.
5. The `userToken` must be read from an environment variable (e.g., `DEEPSEEK_WEB_USER_TOKEN`) and never hard-coded or logged.
6. The adapter must handle rate-limiting and cooldowns using the existing `live.ts` / `routing.ts` mechanisms.

## IMPLEMENTATION PLAN
### Phase 1: Configuration
- Extend the `ProviderConfig` type in `src/config.ts` to support `protocol: "deepseek-web"`.
- Add a new key to `routes.json` (example):
  ```json
  "deepseek-web": {
    "baseURL": "https://chat.deepseek.com",
    "protocol": "deepseek-web",
    "auth": "none",
    "keys": ["DEEPSEEK_WEB_USER_TOKEN"],
    "models": {
      "ds-web-pro": "deepseek-v4-pro-web",
      "ds-web-fast": "deepseek-v4-flash-web"
    },
    "capabilities": { "tools": true, "vision": false }
  }
````

- Ensure `.env.example` includes `DEEPSEEK_WEB_USER_TOKEN=`.

### Phase 2: PoW Solver (`src/deepseek-web-pow.ts`)

- Implement a function `solvePoW(challenge: PoWChallenge): string` that takes the challenge from DeepSeek (algorithm `DeepSeekHashV1`) and returns the computed answer.
- Use Node.js `WebAssembly` to instantiate a locally stored WASM module (you may embed the WASM binary as a base64 string in the source if a separate file is not desired, but ensure it is bundled with the build).
- The challenge structure typically includes fields like `algorithm`, `challenge`, `salt`, `difficulty`, `signature`, `target_path`. You must replicate the logic used by the DeepSeek web app (as seen in the JinBeiCN repo) to compute the answer.

### Phase 3: DeepSeek Web Client (`src/deepseek-web.ts`)

- Implement a class `DeepSeekWebClient` that:
  - Authenticates with the `userToken` by calling `GET https://chat.deepseek.com/api/v0/users/current` with header `Authorization: Bearer <userToken>`.
  - Creates a new chat session (if needed) via `POST https://chat.deepseek.com/api/v0/chat_session/create`.
  - Sends chat completion requests to `POST https://chat.deepseek.com/api/v0/chat/completion` with the required payload (messages, model, etc.).
  - Handles SSE streaming from DeepSeek (content-type `text/event-stream`) and parses the events.
- Transform Anthropic Messages request (system, messages, tools, etc.) into the DeepSeek web request payload. For tool calling, you may use a DSML (DeepSeek Markup Language) prompt injection approach if the web API does not natively support tools.
- Transform the DeepSeek response (streaming or non-streaming) back into Anthropic Messages response format, including `message_start`, `content_block_delta`, `message_delta`, etc.

### Phase 4: Integration (`src/index.ts`)

- In `proxyMessages`, add a new branch:
  ```typescript
  if (provider.protocol === "deepseek-web") {
    // use the DeepSeekWebClient to handle the request
    const client = new DeepSeekWebClient(provider, keyValue);
    return await client.handleMessagesRequest(body, signal);
  }
  ```
- Ensure the request pipeline (capacity, contextGuard, memory, etc.) still applies before routing.

### Phase 5: Admin UI (optional but recommended)

- Add a provider template for "DeepSeek Web" in `src/catalog.ts`.
- Ensure the provider can be added/edited via the existing admin routes without code changes.

## VALIDATION & TESTING

1. Write a unit test for the PoW solver using a known challenge and expected answer (you can obtain one from the JinBeiCN repo's test data).
2. Write an integration test that mocks the DeepSeek web API endpoints using `node:test` and a local HTTP server (similar to existing smoke tests).
3. Ensure `npm run check` (tsc --noEmit) passes.
4. Add a smoke test suite `scripts/smoke-deepseek-web.mjs` that runs against a mock upstream.

## DELIVERABLES

- New files: `src/deepseek-web.ts`, `src/deepseek-web-pow.ts`, and optionally a `.wasm` file.
- Modified files: `src/config.ts` (types), `src/index.ts` (routing), `routes.json` (example), `.env.example`, `src/catalog.ts` (card).
- A README section explaining how to obtain the `userToken` and configure the provider.

## CRITICAL WARNINGS

- This feature uses an **unsanctioned web API** and carries a high risk of account bans. You must include a clear warning in the code comments and README: use a throwaway account, never the primary account.
- Do NOT implement any browser automation (Playwright/Puppeteer). The solution must be pure HTTP + WASM.
- Do NOT log the `userToken` or any sensitive credentials.
- Keep the implementation isolated; if DeepSeek changes its API, only the `deepseek-web` module should break, not the rest of the router.

Start by exploring the existing `src/openai.ts` and `src/index.ts` to understand the adapter pattern, then implement the plan step by step. Output the code changes in a structured format (file paths + full file contents or diffs).

```

---

### সংক্ষিপ্ত সারাংশ

এই প্রম্পটটি আপনার লোকাল AI-কে নির্দেশ দেবে:
1. **`src/deepseek-web.ts`** এবং **`src/deepseek-web-pow.ts`** নামে দুটি নতুন মডিউল তৈরি করতে, যা DeepSeek ওয়েবের `userToken` ও PoW চ্যালেঞ্জ হ্যান্ডেল করবে।
2. **`routes.json`**-এ `protocol: "deepseek-web"` যোগ করে নতুন প্রোভাইডার কনফিগার করতে।
3. **`src/index.ts`**-এ বিদ্যমান `proxyMessages` ফাংশনে নতুন প্রোটোকল ব্রাঞ্চ যোগ করতে।
4. কোনো থার্ড-পার্টি ব্রিজ বা এক্সটার্নাল বাইনারি ব্যবহার না করে, সম্পূর্ণ ফিচারটি আপনার Node.js কোডবেসের ভেতরেই ইমপ্লিমেন্ট করতে।

এটি করার মাধ্যমে আপনি `claude-router`-এর ভেতরেই একটি নেটিভ DeepSeek ওয়েব-টু-API অ্যাডাপ্টার পাবেন, যা আপনার নির্দেশিত রিপোজিটরির কার্যকারিতা অনুকরণ করবে কিন্তু কোনো বাহ্যিক নির্ভরতা ছাড়াই।
```

আপনার দেওয়া রিপোজিটরিটি এবং সংশ্লিষ্ট টেকনিক্যাল ডকুমেন্টেশন (PoW চ্যালেঞ্জ, SSE স্ট্রিমিং, DSML টুল কলিং, userToken অথেন্টিকেশন) গভীরভাবে বিশ্লেষণ করে আমি দেখেছি যে আপনার আগের প্রম্পটে কিছু গুরুত্বপূর্ণ টেকনিক্যাল ডিটেইলস অনুপস্থিত ছিল। যেমন—PoW-এর সঠিক হ্যাশ ফর্মুলা, `X-DS-PoW-Response` হেডার, SSE ইভেন্টের নাম, DSML টুল কলের মার্কার ইত্যাদি। এগুলো ছাড়া লোকাল AI সঠিকভাবে ইমপ্লিমেন্ট করতে পারবে না। তাই আমি প্রম্পটটিকে সম্পূর্ণ নতুন করে সাজিয়েছি, যাতে আপনার লোকাল AI কোনো বিভ্রান্তি ছাড়াই ধাপে ধাপে কাজ করতে পারে।

নিচে **আপডেটেড এবং সম্পূর্ণ প্রম্পট** দেওয়া হলো।

---

### আপনার লোকাল AI-এর জন্য চূড়ান্ত প্রম্পট (কপি-পেস্ট করুন)

````
You are a senior TypeScript/Node.js engineer working on the `claude-router` project (a local Anthropic-compatible AI gateway built with Node.js stdlib only, zero runtime dependencies). Your task is to implement a NATIVE, first-party DeepSeek Web-to-API feature directly inside the router. Do NOT use any third-party bridge (no ds2api, no CLIProxyAPI, no external Python/Go binaries, no browser automation). All logic must live inside the existing `claude-router` codebase and be activated via a new provider protocol `"deepseek-web"`.

## OBJECTIVE
Allow Claude Code (or any Anthropic-Messages-speaking client) to consume a free `chat.deepseek.com` web account as a model provider. The adapter must:
- Authenticate using a `userToken` extracted from the browser's localStorage (read from an env var `DEEPSEEK_WEB_USER_TOKEN`).
- Solve DeepSeek's Proof-of-Work (PoW) challenge (`DeepSeekHashV1`) before every chat completion request.
- Create and manage chat sessions on DeepSeek's backend.
- Translate Anthropic Messages API requests to DeepSeek's internal web API payload.
- Parse DeepSeek's SSE streaming response and re-emit it in Anthropic SSE format.
- Support tool calling via DeepSeek's native DSML markup (if the model emits it) or via prompt injection as a fallback.

## ARCHITECTURE CONSTRAINTS
1.  Create a new module `src/deepseek-web.ts` that exports an adapter similar to the existing `src/openai.ts`.
2.  The adapter must be selected via `protocol: "deepseek-web"` in `routes.json`. Extend the `ProviderConfig` type in `src/config.ts`.
3.  Integrate the adapter into `src/index.ts` `proxyMessages` alongside the existing `isOpenAI` branch. Reuse the existing routing, cooldown, and live-tracking mechanisms.
4.  The PoW solver must be pure Node.js. Use Node.js `WebAssembly` API to execute a locally stored WASM binary (e.g., `src/deepseek-pow.wasm`). Do NOT fetch the WASM from the internet at runtime. You may embed the WASM as a base64 string in the source if a separate file is not desired, but ensure it is bundled with the build.
5.  The `userToken` must never be logged, hard-coded, or returned in any API response. Read it only from the environment variable.

## IMPLEMENTATION PLAN – PHASE BY PHASE

### Phase 1: Configuration
- Extend `ProviderConfig` in `src/config.ts` to accept `protocol: "deepseek-web"`.
- Add a new provider entry in `routes.json` (example):
  ```json
  "deepseek-web": {
    "baseURL": "https://chat.deepseek.com",
    "protocol": "deepseek-web",
    "auth": "none",
    "keys": ["DEEPSEEK_WEB_USER_TOKEN"],
    "models": {
      "ds-web-pro": "deepseek-v4-pro-web",
      "ds-web-fast": "deepseek-v4-flash-web"
    },
    "capabilities": { "tools": true, "vision": false }
  }
````

- Add `DEEPSEEK_WEB_USER_TOKEN=` to `.env.example`.

### Phase 2: PoW Solver (`src/deepseek-web-pow.ts`)

- DeepSeek's PoW challenge object contains fields: `salt` (string), `expire_at` (number), `difficulty` (number, typical 144000), `challenge` (32-byte hex string), `algorithm` (must be `"DeepSeekHashV1"`), `signature` (string).
- The task is to find an integer `nonce` from `0` to `difficulty` such that:
  `Keccak-256(f"{salt}_{expire_at}_{nonce}") === challenge`
- Implement a function `solvePoW(challenge: PoWChallenge): string` that returns the computed answer. Use the locally stored WASM binary for performance. The WASM module `wasm_solve` function signature is: `wasm_solve(retptr, challengePtr, challengeLen, prefixPtr, prefixLen, difficulty)`. It returns a status (int32) and the answer (float64). If the status is non-zero, the answer is valid.
- Pack the found `nonce` and the original challenge fields into a JSON object, then base64-encode it. This base64 string is sent as the `X-DS-PoW-Response` header on the subsequent chat request.

### Phase 3: DeepSeek Web Client (`src/deepseek-web.ts`)

#### 3.1 Authentication

- Validate the `userToken` by calling `GET https://chat.deepseek.com/api/v0/users/current` with header `Authorization: Bearer <userToken>`. A 200 response confirms the token is valid; a 401 indicates an expired token.

#### 3.2 Session Management

- Before sending a chat completion, create a new chat session if necessary via `POST https://chat.deepseek.com/api/v0/chat_session/create`. Store the returned session ID.

#### 3.3 Chat Completion Request

- Send a `POST` to `https://chat.deepseek.com/api/v0/chat/completion` with:
  - `Authorization: Bearer <userToken>`
  - `X-DS-PoW-Response: <base64-encoded-pow-answer>`
  - Body: JSON containing `chat_session_id`, `prompt` (the latest user message), and `ref_file_ids` (empty array). The exact payload structure should mirror what the JinBeiCN/DeepSeek-Free-API repository uses.
- Transform the Anthropic Messages request (system prompt, messages array, tools) into this payload. For system prompts and multi-turn history, concatenate them into a single prompt string in the format DeepSeek's web UI expects.

#### 3.4 SSE Streaming Response

- The response is an SSE stream (`text/event-stream`). Parse it line by line.
- The SSE event types observed in DeepSeek's stream are: `ready`, `update_session`, `message`, `finish`, `title`, `close`.
- The `message` event contains the actual content. It may carry:
  - `content` (regular response text)
  - `reasoning_content` (for reasoner models)
  - `status` or `quasi_status` (control frames)
- Accumulate content fragments in order. An empty `message` payload is a no-op and should be ignored.
- The stream ends when a `finish` event arrives, followed by a `close` event.

#### 3.5 Tool Calling (DSML)

- DeepSeek Web does not expose a standard `tools` parameter. Instead, the model emits tool calls in its native DSML markup:
  `<｜DSML｜ calls><｜DSML｜ invoke name="tool_name"><｜DSML｜ parameter name="param1">value1</｜DSML｜ parameter></｜DSML｜ invoke></｜DSML｜ calls>`
- After receiving the full response, scan the content for this DSML envelope. If found, parse the tool name and parameters, remove the DSML block from the visible content, and emit an Anthropic `content_block` of type `tool_use`.
- If the model does not emit DSML but tools were requested, fall back to a prompt injection approach: inject tool definitions into the system prompt and ask the model to respond with a JSON block in the format `{"tool": "name", "args": {...}}`. Parse that JSON and emit a `tool_use` block.

### Phase 4: Integration (`src/index.ts`)

- Add a branch in `proxyMessages`:
  ```typescript
  if (provider.protocol === "deepseek-web") {
    const client = new DeepSeekWebClient(provider, keyValue);
    return await client.handleMessagesRequest(body, signal);
  }
  ```
- Ensure the existing pipeline (capacity, contextGuard, memory, ETA) still runs before routing.

### Phase 5: Admin UI & Catalog (recommended)

- Add a provider template card for "DeepSeek Web" in `src/catalog.ts` with a warning: "Unofficial API; use a throwaway account; risk of ban."
- Ensure the provider can be added/edited via existing admin routes without further code changes.

## VALIDATION & TESTING

1.  Write a unit test for `solvePoW` using a known challenge (e.g., from the JinBeiCN repository's test data). Assert that the solver returns a nonce that satisfies the Keccak-256 condition.
2.  Write an integration test using `node:test` that mocks the DeepSeek endpoints (`/users/current`, `/chat_session/create`, `/chat/completion`) and verifies both non-streaming and streaming responses, including a DSML tool call.
3.  Ensure `npm run check` (tsc --noEmit) passes.
4.  Add a smoke test suite `scripts/smoke-deepseek-web.mjs` that runs against a mock upstream.

## DELIVERABLES

- New files: `src/deepseek-web.ts`, `src/deepseek-web-pow.ts`, and `src/deepseek-pow.wasm` (or an embedded base64 constant).
- Modified files: `src/config.ts` (type), `src/index.ts` (routing branch), `routes.json` (example entry), `.env.example`, `src/catalog.ts` (card).
- A README section explaining: how to obtain the `userToken` from `chat.deepseek.com` (localStorage), the ban risk, and how to configure the provider.

## CRITICAL WARNINGS (include these in code comments and README)

- This feature uses an unsanctioned web API. DeepSeek may ban the account without warning. **Never use a primary account; use a throwaway account only.**
- Do NOT implement browser automation (Playwright/Puppeteer). The solution must be pure HTTP + WASM.
- Do NOT log the `userToken` or any sensitive credentials.
- Keep the implementation isolated: if DeepSeek changes its API, only the `deepseek-web` module should break, not the rest of the router.

Start by reading `src/openai.ts` and `src/index.ts` to understand the adapter pattern, then implement the plan step by step. Output the code changes in a structured format (file paths + full file contents or diffs).

```

---

### সংক্ষিপ্ত সারাংশ

এই আপডেটেড প্রম্পটে আগের সংস্করণের তুলনায় নিম্নলিখিত গুরুত্বপূর্ণ উন্নতি করা হয়েছে:

| দিক | আগের প্রম্পটে | আপডেটেড প্রম্পটে |
|---|---|---|
| **PoW ফর্মুলা** | শুধু "solve" বলা ছিল | সঠিক `Keccak-256(f"{salt}_{expire_at}_{nonce}") === challenge` ফর্মুলা এবং `X-DS-PoW-Response` হেডার যোগ করা হয়েছে |
| **WASM ইন্টিগ্রেশন** | অস্পষ্ট | `wasm_solve` ফাংশন সিগনেচার এবং লোকাল WASM বাইনারি ব্যবহারের নির্দেশনা যোগ করা হয়েছে |
| **SSE ইভেন্ট** | শুধু "SSE" বলা ছিল | `ready`, `update_session`, `message`, `finish` ইভেন্টের নাম এবং `reasoning_content` ফিল্ডের উল্লেখ যোগ করা হয়েছে |
| **টুল কলিং** | "prompt injection" | DSML মার্কার (`<｜DSML｜ calls>`) এর সঠিক সিনট্যাক্স এবং ফলব্যাক স্ট্র্যাটেজি যোগ করা হয়েছে |
| **অথেন্টিকেশন** | "userToken" | `GET /api/v0/users/current` এন্ডপয়েন্ট এবং Bearer টোকেন ভ্যালিডেশনের নির্দেশনা যোগ করা হয়েছে |
| **সেশন ম্যানেজমেন্ট** | উল্লেখ ছিল না | `POST /api/v0/chat_session/create` এন্ডপয়েন্ট যোগ করা হয়েছে |
| **পেলোড ফরম্যাট** | অস্পষ্ট | `chat_session_id`, `prompt`, `ref_file_ids` ফিল্ডের উল্লেখ যোগ করা হয়েছে |

এই প্রম্পটটি এখন DeepSeek ওয়েব API-এর সমস্ত পরিচিত টেকনিক্যাল দিক (PoW, SSE, DSML, userToken) কভার করে এবং `claude-router`-এর আর্কিটেকচারের সাথে সুনির্দিষ্টভাবে ইন্টিগ্রেট করার নির্দেশনা দেয়। আপনার লোকাল AI এই প্রম্পট অনুসরণ করে একটি সম্পূর্ণ নেটিভ DeepSeek ওয়েব-টু-API অ্যাডাপ্টার তৈরি করতে সক্ষম হবে।
```
