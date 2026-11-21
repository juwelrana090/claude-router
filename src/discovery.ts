import type { ProviderCfg } from "./config";
import { openaiHeaders } from "./openai";

/**
 * Dynamic model discovery: asks the provider for its live model list so the UI can offer
 * real ids instead of a hand-typed guess. OpenAI-style providers answer `GET {baseURL}/models`
 * with `{data:[{id}]}`; Anthropic-style answer `GET {baseURL}/v1/models` with `{data:[{id}]}`;
 * some return `{models:[{id|name}]}` or a bare array — all three shapes are normalized.
 * Results are cached for a few minutes; a failure is never cached.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const TTL_MS = 5 * 60_000;
const cache = new Map<string, { at: number; models: string[] }>();

function extractIds(j: Json): string[] {
  const rows: Json[] = [
    ...(Array.isArray(j) ? j : []),
    ...(Array.isArray(j?.data) ? j.data : []),
    ...(Array.isArray(j?.models) ? j.models : []),
  ];
  const ids: string[] = [];
  for (const row of rows) {
    const id = typeof row === "string" ? row : (row?.id ?? row?.name);
    if (typeof id === "string" && id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** Fetch the provider's current model ids (auth "none" providers work too). Throws on HTTP/network errors. */
export async function listUpstreamModels(name: string, p: ProviderCfg): Promise<string[]> {
  const cacheKey = `${name}@${p.baseURL}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.models;
  const keyName = p.keys?.find((k) => process.env[k]);
  const isOpenAI = p.protocol === "openai";
  const headers = isOpenAI
    ? openaiHeaders(p, keyName ?? "")
    : {
        ...(p.auth === "bearer" || p.auth === "both" ? { authorization: `Bearer ${process.env[keyName ?? ""] ?? ""}` } : {}),
        ...(p.auth === "x-api-key" || p.auth === "both" ? { "x-api-key": process.env[keyName ?? ""] ?? "" } : {}),
        "anthropic-version": "2023-06-01",
      };
  const url = isOpenAI ? `${p.baseURL}/models` : `${p.baseURL}/v1/models`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 10_000);
  try {
    const res = await fetch(url, { headers, signal: ac.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`);
    const models = extractIds(await res.json());
    if (!models.length) throw new Error("the provider answered with an empty or unrecognized model list");
    cache.set(cacheKey, { at: Date.now(), models });
    return models;
  } catch (e) {
    if ((e as Error).name === "AbortError") throw new Error("timed out after 10 s");
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
