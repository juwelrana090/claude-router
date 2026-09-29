/**
 * Models admin page — routing table (alias -> provider/model), key pinning,
 * fallback chains, pricing, test + CRUD against /admin/models/:alias.
 *
 * Shared admin plumbing (snapshot view types, icon map, hooks, mutation
 * helpers) is imported from ./Providers — both pages are maintained together
 * and consume the same /admin/snapshot + versioned-body wire contract.
 */
import { DeleteOutlined, EditOutlined, PlusOutlined, ReloadOutlined, ThunderboltOutlined } from '@ant-design/icons';
import { Text } from '@lobehub/ui';
import {
  Alert,
  App,
  Button,
  Flex,
  Form,
  Input,
  InputNumber,
  Modal,
  Select,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import type { TableColumnsType } from 'antd';
import { useEffect, useState } from 'react';
import { api } from '../api';
import {
  fmtUsdPerM,
  ProviderIcon,
  useAdminAction,
  useAdminSnapshot,
  useDeleteFlow,
  useTestModel,
  type AdminModelView,
  type AdminProviderView,
} from './Providers';

const ALIAS_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

// ---------- Add/edit modal ----------

interface ModelFormValues {
  alias?: string;
  provider: string;
  model: string;
  key?: string;
  maxOutputTokens?: number | null;
  fallback?: string[];
  price?: { in?: number | null; out?: number | null; cacheRead?: number | null };
}

function ModelFormModal({
  open,
  model,
  snapshot,
  act,
  onClose,
}: {
  open: boolean;
  /** Null means create. */
  model: AdminModelView | null;
  snapshot: ReturnType<typeof useAdminSnapshot>['snapshot'];
  act: ReturnType<typeof useAdminAction>;
  onClose: () => void;
}) {
  const [form] = Form.useForm<ModelFormValues>();
  const isEdit = !!model;
  const version = snapshot?.version;
  const watchedProvider = Form.useWatch('provider', form);

  useEffect(() => {
    if (!open) return;
    form.resetFields();
    form.setFieldsValue(
      model
        ? {
            provider: model.provider,
            model: model.model,
            key: model.key,
            maxOutputTokens: model.maxOutputTokens ?? null,
            fallback: model.fallback,
            price: model.price
              ? { in: model.price.in, out: model.price.out, cacheRead: model.price.cacheRead ?? null }
              : { in: null, out: null, cacheRead: null },
          }
        : {},
    );
    // Initialise only when the modal opens or a different model is edited. Depending on the
    // `model` object itself re-ran this on every 20s snapshot poll and wiped unsaved edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, model?.alias, form]);

  const providerOptions = (snapshot?.providers ?? []).map((p) => ({ value: p.name, label: p.name }));
  const selectedProvider: AdminProviderView | undefined = snapshot?.providers.find(
    (p) => p.name === (watchedProvider ?? model?.provider),
  );
  const keyOptions = (selectedProvider?.keys ?? []).map((k) => ({ value: k.envName, label: k.envName }));

  const submit = async () => {
    if (!version) return;
    const values = await form.validateFields();
    const price =
      values.price?.in != null && values.price?.out != null
        ? {
            in: values.price.in,
            out: values.price.out,
            ...(values.price.cacheRead != null ? { cacheRead: values.price.cacheRead } : {}),
          }
        : undefined;
    const body = {
      version,
      provider: values.provider,
      model: values.model.trim(),
      key: values.key || null,
      maxOutputTokens: values.maxOutputTokens ?? null,
      fallback: values.fallback ?? [],
      price: price ?? null,
    };
    if (isEdit && model) {
      await act(`Model "${model.alias}"`, () =>
        api(`/admin/models/${encodeURIComponent(model.alias)}`, {
          method: 'PUT',
          body: JSON.stringify(body),
        }),
      );
    } else {
      await act('Model', () =>
        api('/admin/models', { method: 'POST', body: JSON.stringify({ ...body, alias: values.alias }) }),
      );
    }
    onClose();
  };

  const fallbackOptions = (snapshot?.models ?? [])
    .map((m) => m.alias)
    .filter((a) => a !== model?.alias)
    .map((a) => ({ value: a, label: a }));

  return (
    <Modal
      title={isEdit ? `Edit model "${model.alias}"` : 'Add model'}
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
            name="alias"
            label="Alias"
            rules={[
              { required: true, message: 'required' },
              { pattern: ALIAS_RE, message: 'lowercase letters, digits, dot, underscore, dash (max 64)' },
            ]}
          >
            <Input placeholder="deepseek-r1" autoComplete="off" />
          </Form.Item>
        )}
        <Form.Item name="provider" label="Provider" rules={[{ required: true, message: 'required' }]}>
          <Select
            options={providerOptions}
            placeholder="provider"
            showSearch
            optionFilterProp="label"
          />
        </Form.Item>
        <Form.Item
          name="model"
          label="Upstream model id"
          rules={[{ required: true, message: 'required (the upstream model string)' }]}
        >
          <Input placeholder="deepseek-chat" autoComplete="off" />
        </Form.Item>
        <Form.Item
          name="key"
          label="Key"
          tooltip="Pin this model to one specific key, or leave empty to use the provider's key pool."
        >
          <Select
            allowClear
            placeholder="pool (any healthy key)"
            options={keyOptions}
            notFoundContent={
              selectedProvider ? 'This provider has no keys yet' : 'Pick a provider first'
            }
          />
        </Form.Item>
        <Form.Item
          name="maxOutputTokens"
          label="Max output tokens"
          tooltip="Optional cap on output tokens per request. Leave empty for no cap."
        >
          <InputNumber min={1} step={256} style={{ width: '100%' }} placeholder="e.g. 8192" />
        </Form.Item>
        <Form.Item name="fallback" label="Fallback chain" tooltip="Tried in order when the primary fails.">
          <Select mode="multiple" options={fallbackOptions} placeholder="no fallbacks" />
        </Form.Item>
        <Form.Item label="Price (USD per 1M tokens)" style={{ marginBottom: 0 }}>
          <Space.Compact style={{ width: '100%' }}>
            <Form.Item name={['price', 'in']} noStyle>
              <InputNumber min={0} step={0.01} style={{ width: '33%' }} placeholder="in" addonBefore="$" />
            </Form.Item>
            <Form.Item name={['price', 'out']} noStyle>
              <InputNumber min={0} step={0.01} style={{ width: '33%' }} placeholder="out" addonBefore="$" />
            </Form.Item>
            <Form.Item name={['price', 'cacheRead']} noStyle>
              <InputNumber min={0} step={0.01} style={{ width: '34%' }} placeholder="cache read" addonBefore="$" />
            </Form.Item>
          </Space.Compact>
        </Form.Item>
        <Typography.Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 0, fontSize: 12 }}>
          Leave price or max output tokens empty to remove them. Fallbacks are tried in the order listed, one level deep.
        </Typography.Paragraph>
      </Form>
    </Modal>
  );
}

// ---------- Page ----------

function ModelsInner() {
  const { snapshot, loading, error, refresh } = useAdminSnapshot();
  const act = useAdminAction(refresh);
  const deleteFlow = useDeleteFlow(refresh);
  const testModel = useTestModel();

  /** undefined = closed · null = create · string = editing that alias. */
  const [editorAlias, setEditorAlias] = useState<string | null | undefined>(undefined);

  const editTarget = editorAlias ? (snapshot?.models.find((m) => m.alias === editorAlias) ?? null) : null;
  const version = snapshot?.version;

  const columns: TableColumnsType<AdminModelView> = [
    {
      title: 'Alias',
      dataIndex: 'alias',
      render: (_, m) => (
        <Space size={6}>
          <Text strong>{m.alias}</Text>
          {snapshot?.defaultModel === m.alias && (
            <Tooltip title="This is the router's default model">
              <Tag color="gold">default</Tag>
            </Tooltip>
          )}
        </Space>
      ),
    },
    {
      title: 'Provider',
      dataIndex: 'provider',
      render: (_, m) => (
        <Space size={6}>
          <ProviderIcon provider={m.provider} size={16} />
          <Text>{m.provider}</Text>
          {m.providerMissing && (
            <Tooltip title="No provider with this name is configured — the model cannot route">
              <Tag color="red">missing</Tag>
            </Tooltip>
          )}
          {!m.providerMissing && m.providerDisabled && <Tag color="orange">disabled</Tag>}
        </Space>
      ),
    },
    {
      title: 'Model id',
      dataIndex: 'model',
      render: (v: string) => (
        <Typography.Text code copyable={{ text: v }} ellipsis style={{ maxWidth: 240 }}>
          {v}
        </Typography.Text>
      ),
    },
    {
      title: 'Key / pool',
      width: 160,
      render: (_, m) => (
        <Space direction="vertical" size={0}>
          {m.key ? (
            <Tooltip title="Pinned to a specific key">
              <Tag color="purple">{m.key}</Tag>
            </Tooltip>
          ) : (
            <Tag>pool</Tag>
          )}
          <Text type="secondary" style={{ fontSize: 12 }}>
            {m.keysHealthy}/{m.keysTotal} ready
          </Text>
        </Space>
      ),
    },
    {
      title: 'Max out',
      dataIndex: 'maxOutputTokens',
      width: 90,
      render: (_, m) => (m.maxOutputTokens != null ? m.maxOutputTokens.toLocaleString('en-US') : '—'),
    },
    {
      title: 'Fallbacks',
      dataIndex: 'fallback',
      render: (_, m) =>
        m.fallback.length ? (
          <Space size={4} wrap>
            {m.fallback.map((a) => (
              <Tag key={a}>{a}</Tag>
            ))}
          </Space>
        ) : (
          <Text type="secondary">—</Text>
        ),
    },
    {
      title: 'Price in/out',
      dataIndex: 'price',
      width: 120,
      render: (_, m) =>
        m.price ? (
          <Tooltip title={`USD per 1M tokens · in ${fmtUsdPerM(m.price.in)} · out ${fmtUsdPerM(m.price.out)}${m.price.cacheRead != null ? ` · cache read ${fmtUsdPerM(m.price.cacheRead)}` : ''}`}>
            <span>
              {fmtUsdPerM(m.price.in)} / {fmtUsdPerM(m.price.out)}
            </span>
          </Tooltip>
        ) : (
          <Text type="secondary">—</Text>
        ),
    },
    {
      title: '',
      width: 120,
      align: 'right',
      render: (_, m) => (
        <Space size={0}>
          <Tooltip title="Send a 1-token test request">
            <Button
              type="text"
              size="small"
              icon={<ThunderboltOutlined />}
              disabled={m.providerMissing}
              onClick={() => testModel(m.alias)}
            />
          </Tooltip>
          <Tooltip title="Edit">
            <Button type="text" size="small" icon={<EditOutlined />} onClick={() => setEditorAlias(m.alias)} />
          </Tooltip>
          <Tooltip title="Delete">
            <Button
              type="text"
              size="small"
              danger
              icon={<DeleteOutlined />}
              disabled={!version}
              onClick={() =>
                deleteFlow(`model "${m.alias}"`, (cascade) =>
                  api(`/admin/models/${encodeURIComponent(m.alias)}${cascade ? '?cascade=1' : ''}`, {
                    method: 'DELETE',
                    body: JSON.stringify({ version }),
                  }),
                )
              }
            />
          </Tooltip>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <Flex justify="space-between" align="center" style={{ marginBottom: 12 }} wrap="wrap" gap={8}>
        <div>
          <Typography.Title level={4} style={{ margin: 0 }}>
            Models
          </Typography.Title>
          <Text type="secondary">Alias routing with key pinning, fallback chains and pricing.</Text>
        </div>
        <Space>
          <Tooltip title="Refresh">
            <Button icon={<ReloadOutlined />} onClick={() => void refresh()} />
          </Tooltip>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setEditorAlias(null)}>
            Add model
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
        rowKey="alias"
        columns={columns}
        dataSource={snapshot?.models ?? []}
        loading={loading && !snapshot}
        pagination={false}
        size="middle"
      />

      <ModelFormModal
        open={editorAlias !== undefined}
        model={editorAlias ? editTarget : null}
        snapshot={snapshot}
        act={act}
        onClose={() => setEditorAlias(undefined)}
      />
    </div>
  );
}

export default function ModelsPage() {
  return (
    <App>
      <ModelsInner />
    </App>
  );
}
