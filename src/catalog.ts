import type { Protocol } from "./config";

/**
 * Providers worth adding for coding, with the exact address the router needs.
 * Facts were checked against the providers' own pages or docs on the date in `verified`.
 * Free tiers change without notice: every entry links to where the current numbers live.
 */
export interface CatalogModel {
  id: string; // the provider's own model id
  label: string;
  coding?: boolean;
  free?: boolean;
  price?: { in: number; out: number; cacheRead?: number; peak?: boolean }; // USD per 1M tokens
  note?: string;
}

export interface CatalogEntry {
  id: string; // also the default provider name in the router
  name: string;
  tier: "local" | "free" | "freemium" | "cheap";
  protocol: Protocol;
  baseURL: string;
  auth: "bearer" | "x-api-key" | "both" | "none";
  keyUrl?: string;
  pricingUrl?: string;
  summary: string;
  limits?: string;
  privacy?: string;
  steps: string[];
  models: CatalogModel[];
  /** Shown when the provider's model list changes too often to hard-code. */
  customModelHint?: string;
  /** Applied when the provider is created, so the router switches away before the free quota runs out. */
  suggestedLimits?: { dailyRequests?: number; dailyTokens?: number };
  verified: string;
}

export const CATALOG: CatalogEntry[] = [
  {
    id: "ollama-local", name: "Ollama (on your computer)", tier: "local", protocol: "anthropic",
    baseURL: "http://localhost:11434", auth: "none", pricingUrl: "https://ollama.com/pricing",
    summary: "Runs on your own machine: free, private, no limits except your hardware.",
    limits: "Unlimited. Speed and model size depend on your GPU and memory.",
    steps: ["Install Ollama from ollama.com/download and start it.", "Run `ollama pull qwen3-coder` (or any coding model you like).", "Add it here. No key is needed."],
    models: [{ id: "qwen3-coder", label: "Qwen3 Coder", coding: true, free: true, note: "The example model in Ollama's own Claude Code guide. Needs enough RAM or GPU." }],
    customModelHint: "Any model you pulled: use the name shown by `ollama list`.",
    verified: "2026-09-30: docs.ollama.com/api/anthropic-compatibility and ollama.com/pricing",
  },
  {
    id: "ollama-cloud", name: "Ollama Cloud", tier: "freemium", protocol: "anthropic",
    baseURL: "https://ollama.com", auth: "bearer", keyUrl: "https://ollama.com/settings/keys", pricingUrl: "https://ollama.com/pricing",
    summary: "Big open models hosted by Ollama. Free account = starter credits; pay-as-you-go after that.",
    limits: "Free accounts get a starter amount of usage on a smaller set of starter models, one request at a time. Buying credits unlocks every model.",
    privacy: "Ollama states that prompts and responses are never logged or used for training.",
    steps: ["Create an account and an API key at ollama.com/settings/keys.", "Add the provider here with that key (the address is https://ollama.com, not https://ollama.com/api).", "If a model answers with a plan or credit error it is not a starter model: choose another one or add credits."],
    models: [
      { id: "deepseek-v4.1-flash", label: "DeepSeek V4.1 Flash", coding: true, price: { in: 0.30, out: 1.20, cacheRead: 0.006 }, note: "Half price outside 12:00-18:00 UTC on weekdays." },
      { id: "glm-5.3-flash", label: "GLM 5.3 Flash", coding: true, price: { in: 0.15, out: 0.50, cacheRead: 0.03 } },
      { id: "gpt-oss:120b", label: "GPT-OSS 120B", coding: true, price: { in: 0.15, out: 0.60, cacheRead: 0.014 } },
      { id: "gpt-oss:20b", label: "GPT-OSS 20B", coding: true, price: { in: 0.07, out: 0.30, cacheRead: 0.035 } },
      { id: "nemotron-3-super", label: "Nemotron 3 Super", price: { in: 0.015, out: 0.60, cacheRead: 0.015 } },
      { id: "gemma4:31b", label: "Gemma 4 31B", price: { in: 0.14, out: 0.40, cacheRead: 0.05 } },
      { id: "minimax-m3", label: "MiniMax M3", coding: true, price: { in: 0.60, out: 2.40, cacheRead: 0.12 } },
      { id: "kimi-k2.7-code", label: "Kimi K2.7 Code", coding: true, price: { in: 0.95, out: 4.00, cacheRead: 0.19 } },
      { id: "deepseek-v4-pro:0813", label: "DeepSeek V4 Pro", coding: true, price: { in: 1.32, out: 3.96, cacheRead: 0.044 } },
      { id: "glm-5.3", label: "GLM 5.3", coding: true, price: { in: 1.40, out: 4.40, cacheRead: 0.26 } },
    ],
    verified: "2026-09-30: ollama.com/pricing (prices) and ollama.com/api/tags (model ids)",
  },
  {
    id: "openrouter", name: "OpenRouter (free models)", tier: "freemium", protocol: "anthropic",
    baseURL: "https://openrouter.ai/api", auth: "bearer", keyUrl: "https://openrouter.ai/keys", pricingUrl: "https://openrouter.ai/docs/api-reference/limits",
    summary: "One key for hundreds of models, including several with a :free ending.",
    limits: "Free models: 20 requests per minute, 50 requests per day (1,000 per day once you have bought at least $10 of credits).",
    privacy: "Free models can log prompts. If you turned on Zero Data Retention in openrouter.ai/settings/privacy, free models may be blocked (\"no endpoints available matching your guardrail\").",
    steps: ["Create a key at openrouter.ai/keys.", "Add the provider. A daily limit of 50 requests is set for you, so the router moves to the next model before the free quota is used up (raise it if you bought credits)."],
    models: [
      { id: "openrouter/free", label: "Free Models Router", free: true, note: "OpenRouter picks a free model for each request." },
      { id: "nvidia/nemotron-3-ultra-550b-a55b:free", label: "Nemotron 3 Ultra (free)", free: true, coding: true },
    ],
    customModelHint: "Free models end in :free. Copy the id from openrouter.ai/models?q=free.",
    suggestedLimits: { dailyRequests: 50 },
    verified: "2026-09-30: OpenRouter limits page as quoted in a 2026-07-25 comparison; model ids from earlier OpenRouter listings",
  },
  {
    id: "opencode-zen", name: "OpenCode Zen", tier: "freemium", protocol: "anthropic",
    baseURL: "https://opencode.ai/zen", auth: "both", keyUrl: "https://opencode.ai/zen",
    summary: "A curated gateway with some free models and paid ones behind one key.",
    limits: "Which models are free changes over time; the Zen dashboard lists today's free ones.",
    steps: ["Sign in at opencode.ai/zen, add billing details (needed to get a key even for free models) and copy the key.", "Add the provider here."],
    models: [
      { id: "big-pickle", label: "Big Pickle", free: true, coding: true },
      { id: "space-bunny-free", label: "Space Bunny (free)", free: true },
      { id: "deepseek-v4-flash-free", label: "DeepSeek V4 Flash (free)", free: true, coding: true },
    ],
    verified: "2026-09-30: model ids seen in your own routes.json and in OpenCode Zen listings; confirm in the dashboard",
  },
  {
    id: "commandcode", name: "CommandCode", tier: "freemium", protocol: "anthropic",
    baseURL: "https://api.commandcode.ai/provider", auth: "bearer", keyUrl: "https://commandcode.ai/settings/keys", pricingUrl: "https://commandcode.ai/pricing",
    summary: "One key for ~50 models (Claude, GPT, Gemini, DeepSeek, GLM, Kimi, Qwen ...) paid with credits, plus a few free models.",
    limits: "Credit-based: a free tier for solo developers, paid plans from $1/mo ($10 credits) up to the $15/mo Provider API plan (pay-as-you-go top-ups, zero markup). Models marked free cost no credits while the preview or capacity lasts.",
    steps: ["Create an account and an API key at commandcode.ai/settings/keys (the same key works for their CLI and the API).", "Add the provider here.", "Copy model ids from commandcode.ai/docs/reference/cli/models (matching is case-insensitive; the part after / alone also works)."],
    models: [
      { id: "inclusionai/ling-3.1-flash:free", label: "Ling 3.1 Flash (free)", free: true },
      { id: "inclusionai/ling-3.0-flash-sante:free", label: "Ling 3.0 Flash Sante (free)", free: true },
      { id: "poolside/laguna-s-2.1-free", label: "Laguna S 2.1 (free)", free: true, coding: true },
      { id: "stealth/space-bunny-alpha", label: "Space Bunny Alpha (free)", free: true, note: "Free while the stealth preview lasts." },
      { id: "stealth/pixel-canary", label: "Pixel Canary (free)", free: true, note: "Free while the stealth preview lasts." },
      { id: "deepseek/deepseek-v4-flash", label: "DeepSeek V4 Flash", coding: true, note: "The API's default model." },
      { id: "deepseek/deepseek-v4.1-flash", label: "DeepSeek V4.1 Flash", coding: true },
      { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", coding: true, note: "The example model in CommandCode's own API curl." },
      { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", coding: true },
      { id: "claude-opus-5-5", label: "Claude Opus 5.5", coding: true },
      { id: "z-ai/glm-5.3-flash", label: "GLM 5.3 Flash", coding: true },
      { id: "moonshotai/Kimi-K2.7-Code", label: "Kimi K2.7 Code", coding: true },
      { id: "MiniMaxAI/MiniMax-M3", label: "MiniMax M3", coding: true },
      { id: "Qwen/Qwen3.7-Plus", label: "Qwen 3.7 Plus", coding: true },
      { id: "gpt-5.6-luna", label: "GPT-5.6 Luna", note: "Premium closed model, costs credits." },
    ],
    customModelHint: "Copy a current id from commandcode.ai/docs/reference/cli/models. Per-token prices are not published; the credit plans are on their pricing page.",
    verified: "2026-10-01: commandcode.ai/docs/provider (address https://api.commandcode.ai/provider/v1/messages, Bearer auth, key page) and /docs/reference/cli/models (model ids and free marks); plans from /pricing. No per-token prices published (credit-based).",
  },
  {
    id: "zai", name: "Z.ai (GLM)", tier: "cheap", protocol: "anthropic",
    baseURL: "https://api.z.ai/api/anthropic", auth: "both", keyUrl: "https://z.ai/manage-apikey/apikey-list",
    summary: "GLM coding models. Flash models are reported to have a free tier; the others are low-cost.",
    limits: "Third-party lists report roughly 1,000 requests per day on the free Flash tier. Confirm in your Z.ai account.",
    steps: ["Create a key at z.ai/manage-apikey/apikey-list.", "Add the provider here."],
    models: [
      { id: "glm-5.3-flash", label: "GLM 5.3 Flash", coding: true, note: "Flash tier." },
      { id: "glm-5.3", label: "GLM 5.3", coding: true },
    ],
    verified: "2026-09-30: endpoint from Z.ai's Anthropic-compatible docs as quoted by community guides; limits are third-party",
  },
  {
    id: "deepseek", name: "DeepSeek", tier: "cheap", protocol: "anthropic",
    baseURL: "https://api.deepseek.com/anthropic", auth: "both", keyUrl: "https://platform.deepseek.com/api_keys", pricingUrl: "https://platform.deepseek.com/pricing",
    summary: "Very low prices and a big discount for cached input, which suits coding agents.",
    limits: "Pay as you go. No free tier.",
    steps: ["Create a key at platform.deepseek.com/api_keys and add a small balance.", "Add the provider here."],
    models: [
      { id: "deepseek-v4-flash", label: "DeepSeek V4 Flash", coding: true, price: { in: 0.15, out: 0.60, cacheRead: 0.003, peak: true }, note: "Off-peak price; DeepSeek charges double in its peak hours (the router estimates that when 'peak' is on)." },
      { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro", coding: true, price: { in: 0.66, out: 1.98, cacheRead: 0.022, peak: true } },
    ],
    verified: "2026-09-30: ollama.com/pricing lists the same off-peak figures for these models; check platform.deepseek.com/pricing",
  },
  {
    id: "moonshot", name: "Moonshot (Kimi)", tier: "cheap", protocol: "anthropic",
    baseURL: "https://api.moonshot.ai/anthropic", auth: "both", keyUrl: "https://platform.moonshot.ai/console/api-keys",
    summary: "Kimi models with an official Anthropic-style endpoint.",
    steps: ["Create a key at platform.moonshot.ai/console/api-keys.", "Add the provider here and copy a current model id from the console."],
    models: [{ id: "kimi-k2.5", label: "Kimi K2.5", coding: true, note: "Id taken from a community guide; confirm in the console." }],
    customModelHint: "Copy the current id from platform.moonshot.ai.",
    verified: "2026-09-30: endpoint from community guides that quote Moonshot's docs; model id unconfirmed",
  },
  {
    id: "minimax", name: "MiniMax", tier: "cheap", protocol: "anthropic",
    baseURL: "https://api.minimax.io/anthropic", auth: "both",
    summary: "MiniMax M-series coding models with an Anthropic-style endpoint.",
    steps: ["Create a key in the MiniMax platform console.", "Add the provider here."],
    models: [{ id: "minimax-m2.7", label: "MiniMax M2.7", coding: true, note: "Id taken from a community guide; confirm in the console." }],
    verified: "2026-09-30: endpoint from community guides; model id unconfirmed",
  },
  {
    id: "qwen", name: "Alibaba Qwen (DashScope)", tier: "cheap", protocol: "anthropic",
    baseURL: "https://dashscope-intl.aliyuncs.com/apps/anthropic", auth: "both",
    summary: "Qwen models through Alibaba Cloud Model Studio's Anthropic-style endpoint (international).",
    steps: ["Create a DashScope key in Alibaba Cloud Model Studio.", "Add the provider here."],
    models: [{ id: "qwen3.6-plus", label: "Qwen 3.6 Plus", coding: true, note: "Id taken from a community guide; confirm in the console." }],
    verified: "2026-09-30: endpoint from community guides; model id unconfirmed",
  },
  {
    id: "groq", name: "Groq", tier: "free", protocol: "openai",
    baseURL: "https://api.groq.com/openai/v1", auth: "bearer", keyUrl: "https://console.groq.com/keys",
    summary: "Very fast open models. Free plan, no card. The router converts formats for you.",
    limits: "As published in July 2026: 30 requests/min; 1,000/day on the GPT-OSS models and 14,400/day on llama-3.1-8b-instant.",
    steps: ["Create a key at console.groq.com/keys.", "Add the provider. A daily limit of 1,000 requests is set for you."],
    models: [
      { id: "openai/gpt-oss-120b", label: "GPT-OSS 120B", free: true, coding: true, note: "Confirm the exact id in the Groq console." },
      { id: "openai/gpt-oss-20b", label: "GPT-OSS 20B", free: true },
      { id: "llama-3.1-8b-instant", label: "Llama 3.1 8B Instant", free: true },
    ],
    suggestedLimits: { dailyRequests: 1000 },
    verified: "2026-09-30: limits quoted in a 2026-07-25 comparison of free tiers; endpoint from Groq's OpenAI-compatible docs",
  },
  {
    id: "cerebras", name: "Cerebras", tier: "free", protocol: "openai",
    baseURL: "https://api.cerebras.ai/v1", auth: "bearer", keyUrl: "https://cloud.cerebras.ai",
    summary: "Extremely fast inference with a free tier. The router converts formats for you.",
    limits: "Reported at about 1 million tokens per day (2026). The free model list changes often: it shrank to two models on 2026-05-31.",
    steps: ["Create a key at cloud.cerebras.ai.", "Add the provider, then type a model id that is in your dashboard today. A daily budget of 1M tokens is set for you."],
    models: [],
    customModelHint: "Copy a current model id from the Cerebras dashboard; do not reuse an old one.",
    suggestedLimits: { dailyTokens: 1_000_000 },
    verified: "2026-09-30: third-party free-tier comparisons (August 2026); endpoint from Cerebras docs as quoted by community lists",
  },
  {
    id: "gemini", name: "Google Gemini (AI Studio)", tier: "free", protocol: "openai",
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai", auth: "bearer", keyUrl: "https://aistudio.google.com/apikey",
    summary: "Gemini models with a free tier, through Google's OpenAI-compatible endpoint.",
    limits: "Limits apply per project; AI Studio shows the exact numbers for yours.",
    privacy: "On the free tier Google may use your prompts to improve its models (not in the EU, UK or EEA).",
    steps: ["Create a key at aistudio.google.com/apikey.", "Add the provider, then type a Gemini model id from AI Studio (a Flash model is the usual free choice)."],
    models: [],
    customModelHint: "Copy a current Gemini model id from AI Studio.",
    verified: "2026-09-30: ai.google.dev/gemini-api/docs/openai (address); privacy note from a 2026 free-tier comparison",
  },
  {
    id: "nvidia-nim", name: "NVIDIA NIM", tier: "free", protocol: "openai",
    baseURL: "https://integrate.api.nvidia.com/v1", auth: "bearer", keyUrl: "https://build.nvidia.com",
    summary: "Many hosted models with a free developer tier.",
    limits: "Reported at about 40 requests per minute, with phone verification (third-party lists, 2026).",
    steps: ["Create a key at build.nvidia.com.", "Add the provider, then type a model id from the catalog there."],
    models: [],
    customModelHint: "Copy the model id from the model's page on build.nvidia.com.",
    verified: "2026-09-30: third-party free-tier lists (2026); endpoint as listed there",
  },
  {
    id: "mistral", name: "Mistral (La Plateforme)", tier: "free", protocol: "openai",
    baseURL: "https://api.mistral.ai/v1", auth: "bearer", keyUrl: "https://console.mistral.ai/api-keys",
    summary: "Mistral's own models, with a free Experiment tier.",
    privacy: "The free Experiment tier requires you to opt in to training on your data.",
    steps: ["Create a key at console.mistral.ai/api-keys.", "Add the provider, then type a model id from Mistral's model list."],
    models: [],
    customModelHint: "Copy a current model id from docs.mistral.ai.",
    verified: "2026-09-30: OpenRouter's 2026 free-tier comparison and Mistral's OpenAI-compatible address as quoted there",
  },
];
