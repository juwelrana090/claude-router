import { DeleteOutlined, KeyOutlined, PlusOutlined, StopOutlined, CheckCircleOutlined } from '@ant-design/icons';
import { App, Button, Form, Input, Modal, Popconfirm, Result, Select, Space, Table, Tag, Typography } from 'antd';
import type { TableColumnsType } from 'antd';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';
import { fmtDateTime } from '../format';

interface UserRow {
  id: number;
  username: string;
  role: 'admin' | 'user';
  disabled: boolean;
  createdAt: number;
  lastLoginAt: number | null;
}

export default function UsersPage() {
  const { user, isAdmin } = useAuth();
  const { message } = App.useApp();
  const [rows, setRows] = useState<UserRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [resetFor, setResetFor] = useState<UserRow | null>(null);
  const [addForm] = Form.useForm();
  const [resetForm] = Form.useForm();

  const load = useCallback(async () => {
    try {
      setRows((await api<{ users: UserRow[] }>('/admin/users')).users);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [message]);

  useEffect(() => {
    if (isAdmin) void load();
  }, [isAdmin, load]);

  if (!isAdmin) return <Result status="403" title="Admins only" subTitle="Ask an admin to add or change users." />;

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      message.success(ok);
      await load();
    } catch (e) {
      message.error((e as Error).message.replace(/^.*failed: \d+ /, ''));
    }
  };
  const patch = (id: number, body: object, ok: string) =>
    act(() => api(`/admin/users/${id}`, { method: 'PATCH', body: JSON.stringify(body) }), ok);

  const columns: TableColumnsType<UserRow> = [
    {
      title: 'User',
      dataIndex: 'username',
      render: (v: string, r) => (
        <Space>
          <Typography.Text strong>{v}</Typography.Text>
          {r.id === user?.id && <Tag>you</Tag>}
        </Space>
      ),
    },
    {
      title: 'Role',
      dataIndex: 'role',
      width: 150,
      render: (v: UserRow['role'], r) => (
        <Select
          size="small"
          value={v}
          disabled={r.id === user?.id}
          style={{ width: 110 }}
          onChange={(role) => void patch(r.id, { role }, `${r.username} is now ${role}`)}
          options={[
            { value: 'admin', label: 'Admin' },
            { value: 'user', label: 'User (read-only)' },
          ]}
        />
      ),
    },
    {
      title: 'Status',
      dataIndex: 'disabled',
      width: 110,
      render: (d: boolean) => (d ? <Tag color="error">Disabled</Tag> : <Tag color="success">Active</Tag>),
    },
    { title: 'Created', dataIndex: 'createdAt', width: 150, render: (v: number) => fmtDateTime(v) },
    { title: 'Last sign-in', dataIndex: 'lastLoginAt', width: 150, render: (v: number | null) => (v ? fmtDateTime(v) : 'never') },
    {
      title: '',
      width: 130,
      align: 'right',
      render: (_, r) => (
        <Space size={4}>
          <Button size="small" type="text" icon={<KeyOutlined />} title="Reset password" onClick={() => { resetForm.resetFields(); setResetFor(r); }} />
          {r.id !== user?.id && (
            <>
              <Button
                size="small"
                type="text"
                icon={r.disabled ? <CheckCircleOutlined /> : <StopOutlined />}
                title={r.disabled ? 'Enable' : 'Disable'}
                onClick={() => void patch(r.id, { disabled: !r.disabled }, r.disabled ? 'User enabled' : 'User disabled')}
              />
              <Popconfirm
                title={`Delete ${r.username}?`}
                okText="Delete"
                okButtonProps={{ danger: true }}
                onConfirm={() => act(() => api(`/admin/users/${r.id}`, { method: 'DELETE' }), 'User deleted')}
              >
                <Button size="small" type="text" danger icon={<DeleteOutlined />} title="Delete" />
              </Popconfirm>
            </>
          )}
        </Space>
      ),
    },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <div style={{ flex: 1 }}>
          <Typography.Title level={4} style={{ margin: 0 }}>Users</Typography.Title>
          <Typography.Text type="secondary">Admins manage providers, keys, models and users. Users can view everything but change nothing.</Typography.Text>
        </div>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => { addForm.resetFields(); addForm.setFieldsValue({ role: 'user' }); setAdding(true); }}>
          Add user
        </Button>
      </div>
      <Table<UserRow> rowKey="id" size="middle" loading={loading} columns={columns} dataSource={rows} pagination={false} />

      <Modal
        title="Add user"
        open={adding}
        okText="Create"
        onCancel={() => setAdding(false)}
        onOk={() => addForm.submit()}
        destroyOnHidden
      >
        <Form form={addForm} layout="vertical" requiredMark={false} onFinish={(v) => act(() => api('/admin/users', { method: 'POST', body: JSON.stringify(v) }), 'User created').then(() => setAdding(false))}>
          <Form.Item name="username" label="Username" rules={[{ required: true }, { pattern: /^[a-zA-Z0-9._-]{3,32}$/, message: '3-32 letters, digits, . _ -' }]}>
            <Input autoFocus autoComplete="off" />
          </Form.Item>
          <Form.Item name="password" label="Password" rules={[{ required: true }, { min: 8, message: 'At least 8 characters' }]}>
            <Input.Password autoComplete="new-password" />
          </Form.Item>
          <Form.Item name="role" label="Role">
            <Select options={[{ value: 'user', label: 'User (read-only)' }, { value: 'admin', label: 'Admin' }]} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={`Reset password for ${resetFor?.username ?? ''}`}
        open={!!resetFor}
        okText="Set password"
        onCancel={() => setResetFor(null)}
        onOk={() => resetForm.submit()}
        destroyOnHidden
      >
        <Form form={resetForm} layout="vertical" requiredMark={false} onFinish={(v) => resetFor && patch(resetFor.id, { password: v.password }, 'Password changed; their sessions were signed out').then(() => setResetFor(null))}>
          <Form.Item name="password" label="New password" rules={[{ required: true }, { min: 8, message: 'At least 8 characters' }]}>
            <Input.Password autoFocus autoComplete="new-password" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
