import { LockOutlined, UserOutlined } from '@ant-design/icons';
import { Alert, Button, Card, Form, Input, Typography, theme as antdTheme } from 'antd';
import { useState } from 'react';
import { useAuth } from '../auth';

interface Values {
  username: string;
  password: string;
  confirm?: string;
}

/** Sign-in, or (first run only) creation of the first admin account. */
export default function LoginPage() {
  const { needsSetup, login, setup } = useAuth();
  const { token } = antdTheme.useToken();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const onFinish = async (v: Values) => {
    setBusy(true);
    setError(null);
    try {
      if (needsSetup) await setup(v.username.trim(), v.password);
      else await login(v.username.trim(), v.password);
    } catch (e) {
      setError((e as Error).message.replace(/^.*failed: \d+ /, ''));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24, background: token.colorBgLayout }}>
      <Card style={{ width: 400, maxWidth: '100%' }} styles={{ body: { padding: 32 } }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 24 }}>
          <img src="/logo.svg" alt="" style={{ height: 36 }} />
          <div>
            <Typography.Title level={4} style={{ margin: 0 }}>
              Claude Router
            </Typography.Title>
            <Typography.Text type="secondary">{needsSetup ? 'Create the admin account' : 'Sign in to continue'}</Typography.Text>
          </div>
        </div>
        {needsSetup && (
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 16 }}
            message="First run"
            description="No users exist yet. This account becomes the admin and can add other users later."
          />
        )}
        {error && <Alert type="error" showIcon style={{ marginBottom: 16 }} message={error} />}
        <Form<Values> layout="vertical" onFinish={onFinish} requiredMark={false} autoComplete="on">
          <Form.Item
            name="username"
            label="Username"
            rules={[{ required: true, message: 'Enter your username' }, ...(needsSetup ? [{ pattern: /^[a-zA-Z0-9._-]{3,32}$/, message: '3-32 letters, digits, . _ -' }] : [])]}
          >
            <Input prefix={<UserOutlined />} autoFocus autoComplete="username" />
          </Form.Item>
          <Form.Item
            name="password"
            label="Password"
            rules={[{ required: true, message: 'Enter your password' }, ...(needsSetup ? [{ min: 8, message: 'At least 8 characters' }] : [])]}
          >
            <Input.Password prefix={<LockOutlined />} autoComplete={needsSetup ? 'new-password' : 'current-password'} />
          </Form.Item>
          {needsSetup && (
            <Form.Item
              name="confirm"
              label="Confirm password"
              dependencies={['password']}
              rules={[
                { required: true, message: 'Repeat the password' },
                ({ getFieldValue }) => ({
                  validator: (_, value) =>
                    !value || getFieldValue('password') === value ? Promise.resolve() : Promise.reject(new Error('Passwords do not match')),
                }),
              ]}
            >
              <Input.Password prefix={<LockOutlined />} autoComplete="new-password" />
            </Form.Item>
          )}
          <Button type="primary" htmlType="submit" block loading={busy} style={{ marginTop: 8 }}>
            {needsSetup ? 'Create admin account' : 'Sign in'}
          </Button>
        </Form>
      </Card>
    </div>
  );
}
