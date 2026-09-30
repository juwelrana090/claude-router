/**
 * Providers admin page — table, CRUD, key management, connection test.
 *
 * The shared admin plumbing (accurate snapshot view types, provider icon map,
 * snapshot hook, mutation/error helpers) lives here; Models.tsx imports it.
 *
 * Wire notes verified against the running router (src/admin.ts, which is the
 * source of truth — the scaffold types in ../types.ts predate this wire, e.g.
 * they type `version` as a number while the server issues a string hash):
 *  - Every mutating body echoes `version` (string) back; DELETE
 *    /admin/providers/:name instead takes it in the `x-config-version` header.
 *  - A 409 means the config moved on disk (stale version) or the entry is
 *    still referenced; deletes may be retried with `?cascade=1`.
 *  - Keys: POST /admin/providers/:name/keys {version, envName, value} and
 *    DELETE /admin/providers/:name/keys/:envName {version} (+ cascade).
 *    Values are write-only; the API only ever returns name + last 4.
 *  - Cooldowns: POST /admin/keys/:envName/reset-cooldown.
 *  - The only endpoint that calls upstream is POST /admin/models/:alias/test
 *    with {"confirm":true}; provider-level tests run through one of its models.
 */
import {
  ApiOutlined,
  DeleteOutlined,
  EditOutlined,
  KeyOutlined,
  PlusOutlined,
  PoweroffOutlined,
  ReloadOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import {
  Anthropic,
  Azure,
  Bedrock,
  Baidu,
  Cloudflare,
  Cohere,
  DeepMind,
  DeepSeek,
  Fireworks,
  Gemini,
  Github,
  Google,
  Groq,
  HuggingFace,
  InternLM,
  LmStudio,
  Meta,
  Mistral,
  Minimax,
  ModelScope,
  Moonshot,
  Novita,
  Nvidia,
  Ollama,
  OpenAI,
  OpenRouter,
  Perplexity,
  Qwen,
  Replicate,
  SiliconCloud,
  Tencent,
  Vllm,
  Volcengine,
  XAI,
  ZAI,
  Zhipu,
} from '@lobehub/icons';
import { Text } from '@lobehub/ui';
import {
  Alert,
  App,
  Avatar,
  Badge,
  Button,
  Flex,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import type { TableColumnsType } from 'antd';
import { useCallback, useEffect, useState, type ComponentType } from 'react';
import { ApiError, api } from '../api';
import { fmtCompact } from '../format';

// ---------- Accurate admin view types (server shapes) ----------

export type AuthMode = 'bearer' | 'x-api-key' | 'both' | 'none';
export type Protocol = 'anthropic' | 'openai';

export interface AdminKeyView {
  envName: string;
  configured: boolean;
  last4: string;
  cooldownSeconds: number;
  cooling: boolean;
  /** Why the key is resting, e.g. "HTTP 429: code 1113: Insufficient balance". */
  cooldownReason?: string | null;
  lastUsed?: number;
}

export interface AdminProviderView {
  name: string;
  baseURL: string;
  auth: AuthMode;
  dropBeta: boolean;
  dropBodyFields: string[];
  disabled: boolean;
  keyless?: boolean;
  /** anthropic = the provider speaks Claude's format. openai = chat-completions format, converted by the router. */
  protocol?: Protocol;
  keys: AdminKeyView[];
  keysTotal: number;
  keysHealthy: number;
  models: string[];
  lastUsed?: number;
  /** Optional daily caps (null = unlimited) and what the provider has served since local midnight. */
  dailyRequests?: number | null;
  dailyTokens?: number | null;
  today?: { requests: number; tokens: number };
  /** Set when a daily cap is already reached (the router skips this provider). */
  budgetReason?: string | null;
}

export interface AdminModelView {
  alias: string;
  provider: string;
  model: string;
  key?: string;
  maxOutputTokens?: number;
  fallback: string[];
  price: { in: number; out: number; cacheRead?: number } | null;
  providerMissing: boolean;
  providerDisabled?: boolean;
  keysHealthy: number;
  keysTotal: number;
}

export interface AdminSnapshot {
  ts: number;
  version: string;
  defaultModel: string | null;
  providers: AdminProviderView[];
  models: AdminModelView[];
}

export function fetchAdminSnapshot(): Promise<AdminSnapshot> {
  return api<AdminSnapshot>('/admin/snapshot');
}

// ---------- Formatting helpers ----------

export function describeApiError(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 401) return 'unauthorized — check the ROUTER_KEY';
    if (e.status === 409) return 'the config changed on disk';
    return e.message;
  }
  return e instanceof Error ? e.message : String(e);
}

export function fmtUsdPerM(n: number): string {
  return `$${n >= 100 ? n.toFixed(0) : n.toFixed(2)}`;
}

export function fmtAgo(ts?: number): string {
  if (!ts) return 'never';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

// ---------- Provider icon mapping ----------

type IconComponent = ComponentType<{ size?: number }>;

const ICON_BY_PROVIDER: Record<string, IconComponent> = {
  anthropic: Anthropic,
  claude: Anthropic,
  azure: Azure,
  bedrock: Bedrock,
  aws: Bedrock,
  baidu: Baidu,
  cloudflare: Cloudflare,
  cohere: Cohere,
  deepmind: DeepMind,
  deepseek: DeepSeek,
  fireworks: Fireworks,
  gemini: Gemini,
  github: Github,
  google: Google,
  groq: Groq,
  huggingface: HuggingFace,
  internlm: InternLM,
  lmstudio: LmStudio,
  meta: Meta,
  llama: Meta,
  mistral: Mistral,
  minimax: Minimax,
  modelscope: ModelScope,
  moonshot: Moonshot,
  kimi: Moonshot,
  novita: Novita,
  nvidia: Nvidia,
  ollama: Ollama,
  openai: OpenAI,
  openrouter: OpenRouter,
  perplexity: Perplexity,
  pplx: Perplexity,
  qwen: Qwen,
  dashscope: Qwen,
  replicate: Replicate,
  siliconcloud: SiliconCloud,
  siliconflow: SiliconCloud,
  tencent: Tencent,
  hunyuan: Tencent,
  vllm: Vllm,
  volcengine: Volcengine,
  xai: XAI,
  grok: XAI,
  zai: ZAI,
  zhipu: Zhipu,
  chatglm: Zhipu,
};

const STATIC_ICON_BY_PROVIDER: Record<string, string> = {
  opencode: '/icons/opencode.svg',
};

export function ProviderIcon({ provider, size = 18 }: { provider: string; size?: number }) {
  const key = provider.toLowerCase();
  const Icon =
    ICON_BY_PROVIDER[key] ?? Object.entries(ICON_BY_PROVIDER).find(([k]) => key.includes(k))?.[1];
  if (Icon) return <Icon size={size} />;
  const staticSrc = STATIC_ICON_BY_PROVIDER[key];
  if (staticSrc) {
    return (
      <img
        src={staticSrc}
        width={size}
        height={size}
        alt={provider}
        style={{ display: 'block', flex: 'none' }}
      />
    );
  }
  return (
    <Avatar size={size} style={{ fontSize: Math.max(10, Math.round(size * 0.5)), flex: 'none' }}>
      {provider.charAt(0).toUpperCase() || '?'}
    </Avatar>
  );
}

// ---------- Snapshot hook (poll; mutations also refresh explicitly) ----------

const SNAPSHOT_POLL_MS = 20_000;

export function useAdminSnapshot() {
  const [snapshot, setSnapshot] = useState<AdminSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setSnapshot(await fetchAdminSnapshot());
      setError(null);
    } catch (e) {
      setError(describeApiError(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), SNAPSHOT_POLL_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

  return { snapshot, loading, error, refresh };
}

// ---------- Mutation helpers ----------

export type AdminAction = (
  what: string,
  run: () => Promise<unknown>,
  successText?: string,
) => Promise<boolean>;

/** Toasted mutation wrapper: success toast + refresh; on 409 warn + refresh so the next attempt has a fresh version. */
export function useAdminAction(refresh: () => Promise<void>): AdminAction {
  const { message } = App.useApp();
  return useCallback(
    async (what, run, successText) => {
      try {
        await run();
        message.success(successText ?? `${what}: saved`);
        await refresh();
        return true;
      } catch (e) {
        if (e instanceof ApiError && e.status === 409) {
          message.warning(`${what}: ${describeApiError(e)} — refreshed, please retry.`);
        } else {
          message.error(`${what}: ${describeApiError(e)}`);
        }
        void refresh();
        return false;
      }
    },
    [message, refresh],
  );
}

/**
 * Delete flow with cascade confirm: deletes, and on a 409 (still referenced)
 * offers a cascaded retry which cleans every reference.
 */
export function useDeleteFlow(refresh: () => Promise<void>) {
  const { message, modal } = App.useApp();
  return useCallback(
    (what: string, run: (cascade: boolean) => Promise<unknown>) => {
      modal.confirm({
        title: `Delete ${what}?`,
        content: 'Entries still referenced elsewhere are protected; cascading is offered only when needed.',
        okText: 'Delete',
        okButtonProps: { danger: true },
        onOk: async () => {
          try {
            await run(false);
            message.success(`${what}: deleted`);
            await refresh();
          } catch (e) {
            if (e instanceof ApiError && e.status === 409) {
              modal.confirm({
                title: `${what} is still referenced`,
                content: 'Delete it anyway and clean every reference (cascade)?',
                okText: 'Cascade delete',
                okButtonProps: { danger: true },
                onOk: async () => {
                  try {
                    await run(true);
                    message.success(`${what}: deleted (cascade)`);
                  } catch (err) {
                    message.error(`${what}: ${describeApiError(err)}`);
                  }
                  await refresh();
                },
              });
            } else {
              message.error(`${what}: ${describeApiError(e)}`);
            }
            void refresh();
          }
        },
      });
    },
    [message, modal, refresh],
  );
}

// ---------- Shared test flow (the router's only upstream-calling endpoint) ----------

export interface TestResult {
  ok: boolean;
  status: number;
  ms: number;
  provider: string;
  model: string;
  key: AdminKeyView;
  detail: string;
  /** Plain-language next step when the test failed. */
  hint?: string | null;
}

export function useTestModel() {
  const { modal } = App.useApp();
  return useCallback(
    (alias: string) => {
      modal.confirm({
        title: `Test model "${alias}"?`,
        content: 'Sends a 1-token request upstream. It costs a few tokens and is not recorded in usage.',
        okText: 'Send test',
        onOk: async () => {
          try {
            const r = await api<TestResult>(`/admin/models/${encodeURIComponent(alias)}/test`, {
              method: 'POST',
              body: JSON.stringify({ confirm: true }),
            });
            modal.info({
              title: r.ok
                ? `Reachable — HTTP ${r.status} in ${r.ms} ms`
                : `Not reachable — HTTP ${r.status || 'no response'} in ${r.ms} ms`,
              content: (
                <Space direction="vertical" size={4} style={{ width: '100%' }}>
                  <Text type="secondary">
                    via {r.provider} / {r.model} · key {r.key.envName}
                    {r.key.last4 ? ` (…${r.key.last4})` : ''}
                  </Text>
                  <Typography.Paragraph style={{ marginBottom: 0 }}>
                    <Typography.Text code copyable>
                      {r.detail || '(no detail)'}
                    </Typography.Text>
                  </Typography.Paragraph>
                  {!r.ok && r.hint && <Alert type="warning" showIcon message={r.hint} style={{ marginTop: 8 }} />}
                </Space>
              ),
            });
          } catch (e) {
            modal.error({ title: 'Test request failed', content: describeApiError(e) });
          }
        },
      });
    },
    [modal],
  );
}

// ---------- Page-local constants ----------

const PROVIDER_NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const ENV_NAME_RE = /^[A-Z][A-Z0-9_]{1,63}$/;
const AUTH_MODE_OPTIONS: { value: AuthMode; label: string }[] = [
  { value: 'bearer', label: 'bearer' },
  { value: 'x-api-key', label: 'x-api-key' },
  { value: 'both', label: 'both' },
  { value: 'none', label: 'none (no key needed, e.g. a local Ollama)' },
];

interface DiscoveredKey {
  envName: string;
  configured: boolean;
  last4: string;
  attachedTo: string | null;
  suggestedProvider: string | null;
}

// ---------- Provider add/edit modal ----------

interface ProviderFormValues {
  name?: string;
  baseURL: string;
  auth: AuthMode;
  dropBeta: boolean;
  dropBodyFields?: string[];
  disabled: boolean;
  protocol?: Protocol;
  dailyRequests?: number | null;
  dailyTokens?: number | null;
  keys?: { envName?: string; value?: string }[];
}

function ProviderFormModal({
  open,
  provider,
  version,
  act,
  onClose,
}: {
  open: boolean;
  /** Null means create. */
  provider: AdminProviderView | null;
  version?: string;
  act: AdminAction;
  onClose: () => void;
}) {
  const [form] = Form.useForm<ProviderFormValues>();
  const isEdit = !!provider;

  useEffect(() => {
    if (!open) return;
    form.resetFields();
    form.setFieldsValue(
      provider
        ? {
            baseURL: provider.baseURL,
            auth: provider.auth,
            dropBeta: provider.dropBeta,
            dropBodyFields: provider.dropBodyFields,
            disabled: provider.disabled,
            protocol: provider.protocol ?? 'anthropic',
            dailyRequests: provider.dailyRequests ?? null,
            dailyTokens: provider.dailyTokens ?? null,
          }
        : { auth: 'bearer', protocol: 'anthropic', dropBeta: false, dropBodyFields: [], disabled: false, keys: [{}] },
    );
    // Only on open / different provider: the 20s snapshot poll swaps the `provider` object and
    // would otherwise reset the form under the user's hands.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, provider?.name, form]);

  const submit = async () => {
    if (!version) return;
    const values = await form.validateFields();
    if (isEdit && provider) {
      await act(`Provider "${provider.name}"`, () =>
        api(`/admin/providers/${encodeURIComponent(provider.name)}`, {
          method: 'PUT',
          body: JSON.stringify({
            version,
            baseURL: values.baseURL,
            auth: values.auth,
            dropBeta: values.dropBeta,
            dropBodyFields: values.dropBodyFields ?? [],
            disabled: values.disabled,
            protocol: values.protocol ?? 'anthropic',
            dailyRequests: values.dailyRequests ?? null,
            dailyTokens: values.dailyTokens ?? null,
          }),
        }),
      );
    } else {
      await act('Provider', () =>
        api('/admin/providers', {
          method: 'POST',
          body: JSON.stringify({
            version,
            name: values.name,
            baseURL: values.baseURL,
            auth: values.auth,
            dropBeta: values.dropBeta,
            dropBodyFields: values.dropBodyFields ?? [],
            disabled: values.disabled,
            protocol: values.protocol ?? 'anthropic',
            ...(values.dailyRequests ? { dailyRequests: values.dailyRequests } : {}),
            ...(values.dailyTokens ? { dailyTokens: values.dailyTokens } : {}),
            keys:
              values.auth === 'none'
                ? []
                : (values.keys ?? [])
                    .filter((k) => k && (k.value || k.envName))
                    .map((k) => ({ envName: k.envName?.trim() || undefined, value: k.value?.trim() || undefined })),
          }),
        }),
      );
    }
    onClose();
  };

  return (
    <Modal
      title={isEdit ? `Edit provider "${provider.name}"` : 'Add provider'}
      open={open}
      onCancel={onClose}
      onOk={() => void submit()}
      okText={isEdit ? 'Save' : 'Create'}
      okButtonProps={{ disabled: !version }}
      forceRender
    >
      <Form form={form} layout="vertical" style={{ marginTop: 12 }}>
        {!isEdit && (
          <Form.Item
            name="name"
            label="Name"
            rules={[
              { required: true, message: 'required' },
              { pattern: PROVIDER_NAME_RE, message: 'lowercase letters, digits, dashes (max 32)' },
            ]}
          >
            <Input placeholder="openrouter" autoComplete="off" />
          </Form.Item>
        )}
        <Form.Item name="protocol" label="Provider speaks" tooltip="Most coding providers have an address that speaks Claude's own format (Anthropic style). Some free ones (Groq, Gemini, Cerebras, NVIDIA, Mistral) only speak the OpenAI chat format: choose OpenAI style and the router converts everything, including tool calls and streaming.">
          <Select options={[{ value: 'anthropic', label: 'Anthropic style (Claude format)' }, { value: 'openai', label: 'OpenAI style (chat completions), converted by the router' }]} />
        </Form.Item>
        <Form.Item noStyle shouldUpdate={(a, b) => a.protocol !== b.protocol}>
          {({ getFieldValue }) => (
            <Form.Item
              name="baseURL"
              label="Base URL"
              extra={getFieldValue('protocol') === 'openai'
                ? 'Ends where /chat/completions starts, for example https://api.groq.com/openai/v1. The router adds /chat/completions.'
                : 'Do not add /v1/messages: the router adds it. Ollama cloud is https://ollama.com (no /api); Ollama on your computer is http://localhost:11434.'}
              rules={[{ required: true, message: 'required (https, or http for localhost)' }]}
            >
              <Input placeholder={getFieldValue('protocol') === 'openai' ? 'https://api.example.com/v1' : 'https://api.example.com'} autoComplete="off" />
            </Form.Item>
          )}
        </Form.Item>
        <Form.Item name="auth" label="Auth mode" rules={[{ required: true }]}>
          <Select options={AUTH_MODE_OPTIONS} />
        </Form.Item>
        {!isEdit && (
          <Form.Item noStyle shouldUpdate={(a, b) => a.auth !== b.auth}>
            {({ getFieldValue }) =>
              getFieldValue('auth') === 'none' ? (
                <Alert type="info" showIcon style={{ marginBottom: 16 }} message="No key needed" description="Requests are sent without an Authorization header. Use this for a local server such as Ollama or LM Studio." />
              ) : (
                <>
                  <Typography.Text strong>API keys</Typography.Text>
                  <Typography.Paragraph type="secondary" style={{ margin: '2px 0 8px' }}>
                    Paste one or more keys. Each is written to .env only and never shown again. Leave the name empty to get an automatic one such as MY_PROVIDER_KEY_1. To attach a variable that already exists in .env, type its name and leave the value empty.
                  </Typography.Paragraph>
                  <Form.List name="keys">
                    {(fields, { add, remove }) => (
                      <>
                        {fields.map((f) => (
                          <div key={f.key} style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                            <Form.Item name={[f.name, 'envName']} style={{ flex: '0 0 40%', margin: 0 }} rules={[{ pattern: ENV_NAME_RE, message: 'e.g. MY_PROVIDER_KEY_1' }]}>
                              <Input placeholder="ENV_NAME (optional)" autoComplete="off" />
                            </Form.Item>
                            <Form.Item name={[f.name, 'value']} style={{ flex: 1, margin: 0 }}>
                              <Input.Password placeholder="secret value" autoComplete="new-password" />
                            </Form.Item>
                            <Button type="text" danger icon={<DeleteOutlined />} onClick={() => remove(f.name)} aria-label="Remove key row" />
                          </div>
                        ))}
                        <Button type="dashed" icon={<PlusOutlined />} onClick={() => add({})} style={{ marginBottom: 16 }}>
                          Add another key
                        </Button>
                      </>
                    )}
                  </Form.List>
                </>
              )
            }
          </Form.Item>
        )}
        <Form.Item
          name="dailyRequests"
          label="Daily request limit"
          tooltip="Optional. When this many successful requests were served today (router clock, resets at midnight), the router skips this provider and uses the next model in the fallback list, instead of waiting for the provider to refuse. Leave empty for no limit. Free tiers often have one, e.g. OpenRouter free models."
        >
          <InputNumber min={1} style={{ width: '100%' }} placeholder="no limit" />
        </Form.Item>
        <Form.Item
          name="dailyTokens"
          label="Daily token budget"
          tooltip="Optional. Same idea, counted in tokens: fresh input + cache read + cache write + output. Leave empty for no limit."
        >
          <InputNumber min={10000} step={100000} style={{ width: '100%' }} placeholder="no limit" />
        </Form.Item>
        <Form.Item
          name="dropBodyFields"
          label="Drop body fields"
          tooltip="Request body fields removed before proxying (type to add)."
        >
          <Select mode="tags" open={false} tokenSeparators={[',']} placeholder="e.g. metadata" />
        </Form.Item>
        <Form.Item name="dropBeta" label="Drop beta headers" valuePropName="checked">
          <Switch />
        </Form.Item>
        <Form.Item name="disabled" label="Disabled" valuePropName="checked">
          <Switch />
        </Form.Item>
      </Form>
    </Modal>
  );
}

// ---------- Keys modal ----------

interface AddKeyFormValues {
  envName: string;
  value: string;
}

// ---------- OAuth (PKCE) key acquisition — only OpenRouter publishes a public flow ----------

const OAUTH_PROVIDERS = new Set(['openrouter']);
const oauthVerifierKey = (name: string) => `router_oauth_verifier_${name}`;

function base64url(bytes: Uint8Array): string {
  let str = '';
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function pkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  const challenge = base64url(new Uint8Array(digest));
  return { verifier, challenge };
}

async function startOAuthAuthorize(name: string): Promise<void> {
  const { verifier, challenge } = await pkcePair();
  try {
    sessionStorage.setItem(oauthVerifierKey(name), verifier);
  } catch {
    // Hardened privacy mode can block storage (same guard as api.ts); without the
    // stored verifier the return trip can never finish, so abort before redirecting.
    throw new Error('browser storage unavailable — cannot start authorization');
  }
  const url = new URL('https://openrouter.ai/auth');
  url.searchParams.set('callback_url', window.location.origin + window.location.pathname);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  window.location.href = url.toString();
}

function KeysModal({
  open,
  provider,
  version,
  act,
  deleteFlow,
  onClose,
}: {
  open: boolean;
  provider: AdminProviderView | null;
  version?: string;
  act: AdminAction;
  deleteFlow: ReturnType<typeof useDeleteFlow>;
  onClose: () => void;
}) {
  const [form] = Form.useForm<AddKeyFormValues>();
  const { message } = App.useApp();
  const [found, setFound] = useState<DiscoveredKey[]>([]);
  const providerName = provider?.name;
  const keyCount = provider?.keys.length ?? 0;

  // Variables that exist in .env but are not in this provider's key pool yet.
  useEffect(() => {
    if (!open || !providerName) return;
    let dead = false;
    api<{ keys: DiscoveredKey[] }>(`/admin/env/keys?provider=${encodeURIComponent(providerName)}`)
      .then((r) => !dead && setFound(r.keys))
      .catch(() => !dead && setFound([]));
    return () => {
      dead = true;
    };
  }, [open, providerName, keyCount]);

  if (!provider) {
    return <Modal title="Keys" open={open} onCancel={onClose} footer={null} width={640} />;
  }

  const attach = async (envNames: string[]) => {
    if (!version || !envNames.length) return;
    await act(
      `Attach ${envNames.join(', ')}`,
      () =>
        api(`/admin/providers/${encodeURIComponent(provider.name)}/keys/attach`, {
          method: 'POST',
          body: JSON.stringify({ version, envNames }),
        }),
      `Attached ${envNames.length} key(s) from .env`,
    );
  };

  const addKey = async () => {
    if (!version) return;
    const { envName, value } = await form.validateFields();
    const ok = await act(
      `Key "${envName}"`,
      () =>
        api(`/admin/providers/${encodeURIComponent(provider.name)}/keys`, {
          method: 'POST',
          body: JSON.stringify({ version, envName, value }),
        }),
      `Key "${envName}": written to .env`,
    );
    if (ok) form.resetFields();
  };

  const columns: TableColumnsType<AdminKeyView> = [
    {
      title: 'Env name',
      dataIndex: 'envName',
      render: (v: string) => <Typography.Text code>{v}</Typography.Text>,
    },
    { title: 'Last 4', dataIndex: 'last4', width: 90, render: (v: string) => (v ? `…${v}` : '—') },
    {
      title: 'Status',
      width: 140,
      render: (_, k) =>
        !k.configured ? (
          <Tag color="red">not set</Tag>
        ) : k.cooling ? (
          <Tooltip title={`Resting for another ${k.cooldownSeconds}s${k.cooldownReason ? `. Last error: ${k.cooldownReason}` : ''}. While it rests, requests skip this key and use the next model in the fallback list.`}>
            <Tag color="orange">resting {k.cooldownSeconds}s</Tag>
          </Tooltip>
        ) : (
          <Tag color="green">ready</Tag>
        ),
    },
    {
      title: 'Last used',
      dataIndex: 'lastUsed',
      width: 110,
      render: (_, k) => <Text type="secondary">{fmtAgo(k.lastUsed)}</Text>,
    },
    {
      title: '',
      width: 90,
      align: 'right',
      render: (_, k) => (
        <Space size={0}>
          {k.cooling && (
            <Tooltip title="Reset cooldown">
              <Button
                type="text"
                size="small"
                icon={<ThunderboltOutlined />}
                onClick={() =>
                  void act(
                    `Cooldown of "${k.envName}"`,
                    () => api(`/admin/keys/${encodeURIComponent(k.envName)}/reset-cooldown`, { method: 'POST' }),
                    `Cooldown of "${k.envName}": cleared`,
                  )
                }
              />
            </Tooltip>
          )}
          <Popconfirm
            title={`Remove "${k.envName}" from .env?`}
            okText="Remove"
            okButtonProps={{ danger: true }}
            onConfirm={() =>
              deleteFlow(`key "${k.envName}"`, (cascade) =>
                api(
                  `/admin/providers/${encodeURIComponent(provider.name)}/keys/${encodeURIComponent(k.envName)}${cascade ? '?cascade=1' : ''}`,
                  { method: 'DELETE', body: JSON.stringify({ version }) },
                ),
              )
            }
          >
            <Button type="text" size="small" danger icon={<DeleteOutlined />} disabled={!version} />
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <Modal title={`Keys of "${provider.name}"`} open={open} onCancel={onClose} footer={null} width={640}>
      <div>
        {provider.keyless && <Alert type="info" showIcon style={{ marginBottom: 16 }} message="This provider needs no key (auth: none)." />}
        {found.length > 0 && (
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 16 }}
            message={`${found.length} key${found.length > 1 ? 's' : ''} found in .env but not used by this provider`}
            description={
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6 }}>
                {found.map((k) => (
                  <div key={k.envName} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <Typography.Text code>{k.envName}</Typography.Text>
                    {k.configured ? <Tag color="green">…{k.last4}</Tag> : <Tag>empty in .env</Tag>}
                    <span style={{ flex: 1 }} />
                    <Button size="small" disabled={!version} onClick={() => void attach([k.envName])}>Attach</Button>
                  </div>
                ))}
                {found.length > 1 && (
                  <Button size="small" type="primary" style={{ alignSelf: 'flex-start' }} disabled={!version} onClick={() => void attach(found.map((k) => k.envName))}>
                    Attach all
                  </Button>
                )}
              </div>
            }
          />
        )}
        <Form form={form} layout="inline" style={{ marginBottom: 16 }}>
            <Form.Item
              name="envName"
              rules={[
                { required: true, message: 'required' },
                { pattern: ENV_NAME_RE, message: 'e.g. OPENROUTER_API_KEY' },
              ]}
              style={{ flexGrow: 1, minWidth: 200 }}
            >
              <Input placeholder="ENV_VAR_NAME" autoComplete="off" />
            </Form.Item>
            <Form.Item name="value" rules={[{ required: true, message: 'required' }]}>
              <Input.Password placeholder="secret value (write-only)" autoComplete="new-password" />
            </Form.Item>
            <Form.Item>
              <Button type="primary" icon={<PlusOutlined />} disabled={!version} onClick={() => void addKey()}>
                Add key
              </Button>
            </Form.Item>
          </Form>
          {OAUTH_PROVIDERS.has(provider.name) && (
            <Button
              style={{ marginBottom: 16 }}
              onClick={() =>
                startOAuthAuthorize(provider.name).catch((e) =>
                  message.error(e instanceof Error ? e.message : 'could not start authorization'),
                )
              }
            >
              Authorize with {provider.name} instead
            </Button>
          )}
          <Text type="secondary" style={{ display: 'block', marginBottom: 8 }}>
            Values are written straight to .env and never read back — the table shows only the last 4
            characters. Re-adding an existing env name replaces its value.
          </Text>
          <Table rowKey="envName" columns={columns} dataSource={provider.keys} pagination={false} size="small" />
      </div>
    </Modal>
  );
}

// ---------- Page ----------

function ProvidersInner() {
  const { snapshot, loading, error, refresh } = useAdminSnapshot();
  const act = useAdminAction(refresh);
  const deleteFlow = useDeleteFlow(refresh);
  const testModel = useTestModel();

  /** undefined = closed · null = create · string = editing that provider. */
  const [editorName, setEditorName] = useState<string | null | undefined>(undefined);
  const [keysFor, setKeysFor] = useState<string | null>(null);

  const editTarget = editorName ? (snapshot?.providers.find((p) => p.name === editorName) ?? null) : null;
  const keysTarget = keysFor ? (snapshot?.providers.find((p) => p.name === keysFor) ?? null) : null;
  const version = snapshot?.version;

  // OAuth completion: openrouter redirects back to /ui?code=... — exchange it for a key.
  useEffect(() => {
    const code = new URLSearchParams(window.location.search).get('code');
    if (!code || !version) return;
    let stored: { name: string; verifier: string } | null = null;
    try {
      const name = [...OAUTH_PROVIDERS].find((n) => sessionStorage.getItem(oauthVerifierKey(n)));
      const verifier = name ? sessionStorage.getItem(oauthVerifierKey(name)) : null;
      if (name && verifier) {
        sessionStorage.removeItem(oauthVerifierKey(name));
        stored = { name, verifier };
      }
    } catch {
      stored = null; // sessionStorage unavailable (hardened privacy mode) — same guard as api.ts
    }
    if (!stored) return;
    const { name, verifier } = stored;
    window.history.replaceState({}, '', window.location.pathname);
    const provider = snapshot?.providers.find((p) => p.name === name);
    // Skip past existing names: keys.length + 1 collides after any deletion, and the
    // server would then silently replace that key's stored secret.
    const keyPrefix = `${name.toUpperCase()}_KEY_`;
    let suffix = (provider?.keys.length ?? 0) + 1;
    while (provider?.keys.some((k) => k.envName === keyPrefix + suffix)) suffix++;
    const envName = keyPrefix + suffix;
    void act(
      `${name} authorization`,
      () =>
        api(`/admin/providers/${name}/oauth/exchange`, {
          method: 'POST',
          body: JSON.stringify({ version, envName, code, codeVerifier: verifier }),
        }),
      `${name}: connected as ${envName}`,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, snapshot]);

  const testAliasFor = (p: AdminProviderView): string | undefined => p.models[0];

  const columns: TableColumnsType<AdminProviderView> = [
    {
      title: 'Provider',
      dataIndex: 'name',
      render: (_, p) => (
        <Space size={8}>
          <ProviderIcon provider={p.name} size={20} />
          <Text strong>{p.name}</Text>
          <Text type="secondary">
            {p.models.length} model{p.models.length === 1 ? '' : 's'}
          </Text>
        </Space>
      ),
    },
    {
      title: 'Base URL',
      dataIndex: 'baseURL',
      render: (v: string) => (
        <Typography.Text code copyable={{ text: v }} ellipsis style={{ maxWidth: 300 }}>
          {v}
        </Typography.Text>
      ),
    },
    {
      title: 'Auth',
      dataIndex: 'auth',
      width: 150,
      render: (v: string, p) => (
        <span>
          <Tag icon={<ApiOutlined />}>{v}</Tag>
          {p.protocol === 'openai' && (
            <Tooltip title="This provider speaks the OpenAI chat format. The router converts requests and answers for you.">
              <Tag color="blue">OpenAI style</Tag>
            </Tooltip>
          )}
        </span>
      ),
    },
    {
      title: 'Keys',
      width: 120,
      render: (_, p) => (
        <Button type="link" size="small" icon={<KeyOutlined />} onClick={() => setKeysFor(p.name)}>
          {p.keyless ? 'no key needed' : `${p.keysHealthy}/${p.keysTotal} ready`}
        </Button>
      ),
    },
    {
      title: 'Today',
      width: 190,
      render: (_, p) => {
        const t = p.today ?? { requests: 0, tokens: 0 };
        const parts: string[] = [`${fmtCompact(t.requests)} req`, `${fmtCompact(t.tokens)} tok`];
        const hit = !!p.budgetReason;
        return (
          <Tooltip title={p.budgetReason ? `${p.budgetReason}. The router skips this provider until midnight or until you raise the limit.` : 'Served since midnight (router clock). Set daily limits in Edit.'}>
            <div style={{ lineHeight: 1.3 }}>
              <Text style={{ color: hit ? '#E5675F' : undefined }}>{parts.join(' · ')}</Text>
              {(p.dailyRequests || p.dailyTokens) && (
                <div>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    limit {p.dailyRequests ? `${fmtCompact(p.dailyRequests)} req` : ''}{p.dailyRequests && p.dailyTokens ? ' · ' : ''}{p.dailyTokens ? `${fmtCompact(p.dailyTokens)} tok` : ''}
                  </Text>
                </div>
              )}
            </div>
          </Tooltip>
        );
      },
    },
    {
      title: 'Models',
      render: (_, p) =>
        p.models.length ? (
          <Space size={4} wrap>
            {p.models.slice(0, 3).map((a) => (
              <Tag key={a}>{a}</Tag>
            ))}
            {p.models.length > 3 && <Tag>+{p.models.length - 3}</Tag>}
          </Space>
        ) : (
          <Text type="secondary">—</Text>
        ),
    },
    {
      title: 'Status',
      width: 110,
      render: (_, p) =>
        p.disabled ? <Badge status="default" text="disabled" /> : <Badge status="processing" text="enabled" />,
    },
    {
      title: '',
      width: 190,
      align: 'right',
      render: (_, p) => {
        const testAlias = testAliasFor(p);
        return (
          <Space size={0}>
            <Tooltip title="Keys">
              <Button type="text" size="small" icon={<KeyOutlined />} onClick={() => setKeysFor(p.name)} />
            </Tooltip>
            <Tooltip title={testAlias ? `Test connection via "${testAlias}"` : 'Add a model first — tests run through a model'}>
              <Button
                type="text"
                size="small"
                icon={<ThunderboltOutlined />}
                disabled={!testAlias}
                onClick={() => testAlias && testModel(testAlias)}
              />
            </Tooltip>
            <Tooltip title="Edit">
              <Button type="text" size="small" icon={<EditOutlined />} onClick={() => setEditorName(p.name)} />
            </Tooltip>
            <Tooltip title={p.disabled ? 'Enable' : 'Disable'}>
              <Button
                type="text"
                size="small"
                icon={<PoweroffOutlined />}
                disabled={!version}
                onClick={() =>
                  void act(`Provider "${p.name}"`, () =>
                    api(`/admin/providers/${encodeURIComponent(p.name)}/${p.disabled ? 'enable' : 'disable'}`, {
                      method: 'POST',
                      body: JSON.stringify({ version }),
                    }),
                  )
                }
              />
            </Tooltip>
            <Tooltip title="Delete">
              <Button
                type="text"
                size="small"
                danger
                icon={<DeleteOutlined />}
                disabled={!version}
                onClick={() =>
                  deleteFlow(`provider "${p.name}"`, (cascade) =>
                    api(
                      `/admin/providers/${encodeURIComponent(p.name)}${cascade ? '?cascade=1' : ''}`,
                      { method: 'DELETE', headers: { 'x-config-version': version ?? '' } },
                    ),
                  )
                }
              />
            </Tooltip>
          </Space>
        );
      },
    },
  ];

  return (
    <div>
      <Flex justify="space-between" align="center" style={{ marginBottom: 12 }} wrap="wrap" gap={8}>
        <div>
          <Typography.Title level={4} style={{ margin: 0 }}>
            Providers
          </Typography.Title>
          <Text type="secondary">Upstream endpoints, auth mode and key pools. Changes apply to routes.json immediately.</Text>
        </div>
        <Space>
          <Tooltip title="Refresh">
            <Button icon={<ReloadOutlined />} onClick={() => void refresh()} />
          </Tooltip>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setEditorName(null)}>
            Add provider
          </Button>
        </Space>
      </Flex>

      {error && !snapshot && (
        <Alert
          type="error"
          showIcon
          message="Failed to load the snapshot"
          description={error}
          style={{ marginBottom: 12 }}
          action={
            <Button size="small" danger onClick={() => void refresh()}>
              Retry
            </Button>
          }
        />
      )}

      <Table
        rowKey="name"
        columns={columns}
        dataSource={snapshot?.providers ?? []}
        loading={loading && !snapshot}
        pagination={false}
        size="middle"
      />

      <ProviderFormModal
        open={editorName !== undefined}
        provider={editorName ? editTarget : null}
        version={version}
        act={act}
        onClose={() => setEditorName(undefined)}
      />
      <KeysModal
        open={keysFor !== null}
        provider={keysTarget}
        version={version}
        act={act}
        deleteFlow={deleteFlow}
        onClose={() => setKeysFor(null)}
      />
    </div>
  );
}

export default function ProvidersPage() {
  return (
    <App>
      <ProvidersInner />
    </App>
  );
}
