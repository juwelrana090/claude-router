import { Header, Tabs } from '@lobehub/ui';
import { useState } from 'react';
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

export default function App() {
  const [activeKey, setActiveKey] = useState('live');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100vh' }}>
      <Header
        logo={<strong style={{ fontSize: 16 }}>Claude Router</strong>}
        actions={<HeaderWidget />}
      />
      <main style={{ flex: 1, width: '100%', maxWidth: 1280, margin: '0 auto', padding: 16 }}>
        <Tabs items={TAB_ITEMS} activeKey={activeKey} onChange={setActiveKey} />
      </main>
    </div>
  );
}
