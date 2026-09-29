import { Header, Tabs } from '@lobehub/ui';
import { Input, Modal, Typography } from 'antd';
import { useEffect, useRef, useState } from 'react';
import { setUnauthorizedHandler } from './api';
import HeaderWidget from './components/HeaderWidget';
import LivePage from './pages/Live';
import ModelsPage from './pages/Models';
import ProvidersPage from './pages/Providers';
import SettingsPage from './pages/Settings';
import UsagePage from './pages/Usage';

const TAB_ITEMS = [
  { key: 'live', label: 'Live', children: <LivePage /> },
  { key: 'providers', label: 'Providers', children: <ProvidersPage /> },
  { key: 'models', label: 'Models', children: <ModelsPage /> },
  { key: 'usage', label: 'Usage', children: <UsagePage /> },
  { key: 'settings', label: 'Settings', children: <SettingsPage /> },
];

function RouterKeyGate() {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  const resolverRef = useRef<((key: string | null) => void) | null>(null);

  useEffect(() => {
    setUnauthorizedHandler(
      () =>
        new Promise<string | null>((resolve) => {
          resolverRef.current = resolve;
          setValue('');
          setOpen(true);
        }),
    );
  }, []);

  const finish = (key: string | null) => {
    setOpen(false);
    resolverRef.current?.(key);
    resolverRef.current = null;
  };

  return (
    <Modal
      title="Router key required"
      open={open}
      onOk={() => finish(value.trim() || null)}
      onCancel={() => finish(null)}
      okButtonProps={{ disabled: !value.trim() }}
      closable={false}
      maskClosable={false}
    >
      <Typography.Text type="secondary" style={{ display: 'block', marginBottom: 8 }}>
        Enter the ROUTER_KEY to use the admin API.
      </Typography.Text>
      <Input.Password
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onPressEnter={() => value.trim() && finish(value.trim())}
        placeholder="ROUTER_KEY"
      />
    </Modal>
  );
}

export default function App() {
  // OAuth redirect-back lands on /ui?code=...: open on Providers so the exchange
  // effect there runs — Tabs mounts inactive panes lazily.
  const [activeKey, setActiveKey] = useState(
    () => (new URLSearchParams(window.location.search).get('code') ? 'providers' : 'live'),
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100vh' }}>
      <RouterKeyGate />
      <Header
        logo={
          <img src="/logo.svg" alt="Claude Router" style={{ height: 24, display: 'block' }} />
        }
        actions={<HeaderWidget />}
      />
      <main style={{ flex: 1, width: '100%', maxWidth: 1280, margin: '0 auto', padding: '24px 32px 48px' }}>
        <Tabs items={TAB_ITEMS} activeKey={activeKey} onChange={setActiveKey} />
      </main>
    </div>
  );
}
