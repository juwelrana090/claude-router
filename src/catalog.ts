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
  {
    id: "openai", name: "OpenAI", tier: "cheap", protocol: "openai",
    baseURL: "https://api.openai.com/v1", auth: "bearer", keyUrl: "https://platform.openai.com/api-keys", pricingUrl: "https://openai.com/api/pricing/",
    summary: "GPT models, pay as you go. There is no API free tier (free ChatGPT usage does not apply to API keys).",
    steps: ["Create a key at platform.openai.com/api-keys and add at least a few dollars of credit.", "Add the provider here, then use Fetch live models on the provider: the id list is long and changes often."],
    models: [
      { id: "gpt-6.2-astra", label: "GPT-6.2 Astra", coding: true, note: "Id as listed on openrouter.ai today; confirm with Fetch live models." },
      { id: "gpt-6.2-sol", label: "GPT-6.2 Sol", coding: true, note: "Id as listed on openrouter.ai today; confirm with Fetch live models." },
    ],
    customModelHint: "Use Fetch live models on the provider page; ids change often.",
    verified: "2026-11-21: api.openai.com/v1/models probed live (HTTP 401 without a key: address and auth exist); model ids from openrouter.ai/api/v1/models, not re-checked on OpenAI's own endpoint",
  },
  {
    id: "xai", name: "xAI (Grok)", tier: "cheap", protocol: "openai",
    baseURL: "https://api.x.ai/v1", auth: "bearer", keyUrl: "https://console.x.ai", pricingUrl: "https://docs.x.ai",
    summary: "Grok models, pay as you go. xAI has run free credits promotions; check the console for your account.",
    steps: ["Create a team and a key at console.x.ai.", "Add the provider here, then use Fetch live models to see today's Grok ids."],
    models: [
      { id: "grok-4.7", label: "Grok 4.7", coding: true, note: "Id as listed on openrouter.ai today; confirm with Fetch live models." },
      { id: "grok-4.6", label: "Grok 4.6", coding: true, note: "Same: confirm with Fetch live models." },
    ],
    customModelHint: "Use Fetch live models on the provider page; Grok ids change often.",
    verified: "2026-11-21: api.x.ai/v1/models probed live (HTTP 401 without a key); model ids from openrouter.ai/api/v1/models, not re-checked on xAI's own endpoint",
  },
  {
    id: "perplexity", name: "Perplexity (Sonar)", tier: "cheap", protocol: "openai",
    baseURL: "https://api.perplexity.ai", auth: "bearer", keyUrl: "https://www.perplexity.ai/settings/api", pricingUrl: "https://www.perplexity.ai",
    summary: "Search-grounded Sonar models. Answers cite the web, which coding agents can use for fresh library docs.",
    limits: "Pay as you go, priced per request plus per token on some models; see the API settings page.",
    steps: ["Create a key at perplexity.ai/settings/api.", "Add the provider here and type a Sonar id by hand: Perplexity has no model-list endpoint, so Fetch live models will not work."],
    models: [
      { id: "sonar", label: "Sonar", note: "Id as listed on openrouter.ai today." },
      { id: "sonar-pro", label: "Sonar Pro", note: "Deeper search budget." },
      { id: "sonar-reasoning-pro", label: "Sonar Reasoning Pro" },
    ],
    customModelHint: "No /models endpoint exists (probed 2026-11-21): copy the id from the Perplexity API settings page.",
    verified: "2026-11-21: api.perplexity.ai/chat/completions probed live (HTTP 401 without a key); /models returned 404, so the discovery button cannot work here; model ids from openrouter.ai/api/v1/models",
  },
  {
    id: "together", name: "Together AI", tier: "cheap", protocol: "openai",
    baseURL: "https://api.together.xyz/v1", auth: "bearer", keyUrl: "https://api.together.ai/settings/api-keys", pricingUrl: "https://www.together.ai/pricing",
    summary: "Hosted open models (DeepSeek, Qwen, Llama and more), pay as you go.",
    steps: ["Create a key at api.together.ai/settings/api-keys.", "Add the provider here, then use Fetch live models to pick from their catalog."],
    models: [],
    customModelHint: "Use Fetch live models on the provider page: the catalog is large and changes often.",
    verified: "2026-11-21: api.together.xyz/v1/models probed live (HTTP 401 without a key: address and auth exist); model list not fetched (needs a key)",
  },
  {
    id: "fireworks", name: "Fireworks AI", tier: "cheap", protocol: "openai",
    baseURL: "https://api.fireworks.ai/inference/v1", auth: "bearer", keyUrl: "https://fireworks.ai/api-keys", pricingUrl: "https://fireworks.ai/pricing",
    summary: "Fast hosted open models, pay as you go.",
    steps: ["Create a key at fireworks.ai/api-keys.", "Add the provider here, then use Fetch live models to pick from their catalog."],
    models: [],
    customModelHint: "Use Fetch live models on the provider page: the catalog is large and changes often.",
    verified: "2026-11-21: api.fireworks.ai/inference/v1/models probed live (HTTP 401 without a key: address and auth exist); model list not fetched (needs a key)",
  },
  {
    id: "cohere", name: "Cohere (compatibility API)", tier: "cheap", protocol: "openai",
    baseURL: "https://api.cohere.ai/compatibility/v1", auth: "bearer", keyUrl: "https://dashboard.cohere.com/api-keys", pricingUrl: "https://cohere.com/pricing",
    summary: "Command models through Cohere's OpenAI-compatible surface. Only this surface works with the router, not Cohere's native v2/chat API.",
    steps: ["Create a production key at dashboard.cohere.com/api-keys.", "Add the provider here, then use Fetch live models to confirm the current Command ids."],
    models: [
      { id: "command-a-plus", label: "Command A Plus", note: "Id as listed on openrouter.ai today; confirm with Fetch live models." },
      { id: "command-a", label: "Command A" },
    ],
    customModelHint: "Use Fetch live models on the provider page.",
    verified: "2026-11-21: api.cohere.ai/compatibility/v1/models probed live (HTTP 401 without a key: address and auth exist); model ids from openrouter.ai/api/v1/models, not re-checked on Cohere's own endpoint",
  },
  {
    id: "lmstudio", name: "LM Studio (on your computer)", tier: "local", protocol: "openai",
    baseURL: "http://localhost:1234/v1", auth: "none",
    summary: "Runs models on your own machine with an OpenAI-compatible local server. Free and private.",
    limits: "Unlimited. Speed and model size depend on your GPU and memory.",
    steps: ["Install LM Studio, download a model, open the Developer tab and start the server.", "Add the provider here with the address shown in that tab, then Fetch live models to list what you downloaded."],
    models: [],
    customModelHint: "The id is shown next to each model in the Developer tab; Fetch live models lists them too.",
    verified: "unverified: the localhost:1234 default is LM Studio's documented default as widely quoted, but their docs page could not be fetched today (2026-11-21) to re-confirm; the address is shown in the app's Developer tab",
  },
  {
    id: "vllm", name: "vLLM (self-hosted)", tier: "local", protocol: "openai",
    baseURL: "http://localhost:8000/v1", auth: "none",
    summary: "Serve open models yourself with vLLM's OpenAI-compatible server. Free and private.",
    limits: "Unlimited. Speed and model size depend on your GPU and memory.",
    steps: ["Start vLLM with your model, e.g. `vllm serve Qwen/Qwen3-Coder-30B`.", "Add the provider here (if you passed --api-key, switch auth to bearer and add that key), then Fetch live models."],
    models: [],
    customModelHint: "Fetch live models lists exactly what this vLLM instance serves; the id is the model path you passed.",
    verified: "unverified: the localhost:8000 default is vLLM's documented default as widely quoted, but their docs page could not be fetched today (2026-11-21) to re-confirm; `vllm serve` prints the actual address at startup",
  },
  {
    id: "litellm", name: "LiteLLM proxy (any backend)", tier: "local", protocol: "openai",
    baseURL: "http://localhost:4000/v1", auth: "none",
    summary: "Point the router at a LiteLLM proxy to reach backends the router has no adapter for. All models appear OpenAI-style.",
    limits: "Whatever the backends behind your LiteLLM config allow.",
    steps: ["Install LiteLLM, write a config.yaml with your backends and model names, run `litellm --config config.yaml`.", "Add the provider here (if you set a LiteLLM master key, switch auth to bearer and add that key), then Fetch live models."],
    models: [],
    customModelHint: "Model ids are the model_name values in your config.yaml; Fetch live models lists them.",
    verified: "unverified: the localhost:4000 default is LiteLLM's documented default as widely quoted, but their docs page could not be fetched today (2026-11-21) to re-confirm; the proxy prints its address at startup",
  },
];
