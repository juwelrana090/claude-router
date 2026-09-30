import {
  ApiOutlined,
  AppstoreAddOutlined,
  BarChartOutlined,
  BookOutlined,
  DeploymentUnitOutlined,
  DownOutlined,
  HistoryOutlined,
  LogoutOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  RadarChartOutlined,
  SearchOutlined,
  SettingOutlined,
  TeamOutlined,
  UserOutlined,
} from '@ant-design/icons';
import { AutoComplete, Avatar, Button, Dropdown, Input, Layout, Menu, Tag, Typography, theme as antdTheme } from 'antd';
import type { InputRef } from 'antd';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { fetchSnapshot } from '../api';
import { useAppSettings } from '../appSettings';
import { useAuth } from '../auth';
import HeaderWidget from '../components/HeaderWidget';
import type { Snapshot } from '../types';

const { Sider, Header, Content } = Layout;

interface NavItem {
  path: string;
  label: string;
  icon: React.ReactNode;
  adminOnly?: boolean;
  hint: string;
}

const NAV: NavItem[] = [
  { path: '/live', label: 'Live', icon: <RadarChartOutlined />, hint: 'Real-time requests and speed' },
  { path: '/history', label: 'History', icon: <HistoryOutlined />, hint: 'Every request, with tokens and timing' },
  { path: '/providers', label: 'Providers', icon: <ApiOutlined />, hint: 'Upstreams, keys and health' },
  { path: '/catalog', label: 'Catalog', icon: <AppstoreAddOutlined />, hint: 'Free and low-price coding AI, one-click setup' },
  { path: '/models', label: 'Models', icon: <DeploymentUnitOutlined />, hint: 'Aliases, fallbacks and prices' },
  { path: '/usage', label: 'Usage', icon: <BarChartOutlined />, hint: 'Tokens, cost and context size' },
  { path: '/users', label: 'Users', icon: <TeamOutlined />, adminOnly: true, hint: 'Who can sign in' },
  { path: '/instructions', label: 'Instructions', icon: <BookOutlined />, hint: 'How to use free or paid AI' },
  { path: '/settings', label: 'Settings', icon: <SettingOutlined />, hint: 'System, pricing, data and account' },
];

/** Sidebar + top bar. Pages render in the <Outlet/>. */
export default function AppShell() {
  const { token } = antdTheme.useToken();
  const { user, isAdmin, logout } = useAuth();
  const { settings } = useAppSettings();
  const navigate = useNavigate();
  const location = useLocation();
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('router-sider') === '1');
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [query, setQuery] = useState('');
  const searchRef = useRef<InputRef>(null);

  const items = NAV.filter((n) => !n.adminOnly || isAdmin);
  const active = items.find((n) => location.pathname === n.path || location.pathname.startsWith(`${n.path}/`));

  useEffect(() => {
    localStorage.setItem('router-sider', collapsed ? '1' : '0');
  }, [collapsed]);

  // "/" or Ctrl/Cmd+K focuses the search box.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = /input|textarea|select/i.test((e.target as HTMLElement)?.tagName ?? '');
      if ((e.key === '/' && !typing) || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k')) {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const loadSnap = () => {
    if (!snap) void fetchSnapshot().then(setSnap).catch(() => undefined);
  };

  const options = useMemo(() => {
    const q = query.trim().toLowerCase();
    const groups: { label: string; options: { value: string; label: React.ReactNode }[] }[] = [];
    const pages = items.filter((n) => !q || n.label.toLowerCase().includes(q) || n.hint.toLowerCase().includes(q));
    if (pages.length) groups.push({ label: 'Pages', options: pages.map((n) => ({ value: `go:${n.path}`, label: <span>{n.icon} {n.label} <Typography.Text type="secondary" style={{ fontSize: 12 }}>{n.hint}</Typography.Text></span> })) });
    if (q && snap) {
      const prov = snap.providers.filter((p) => p.name.toLowerCase().includes(q)).slice(0, 5);
      if (prov.length) groups.push({ label: 'Providers', options: prov.map((p) => ({ value: `go:/providers?q=${encodeURIComponent(p.name)}`, label: p.name })) });
      const mods = snap.models.filter((m) => `${m.alias} ${m.model}`.toLowerCase().includes(q)).slice(0, 6);
      if (mods.length) groups.push({ label: 'Models', options: mods.map((m) => ({ value: `go:/models?q=${encodeURIComponent(m.alias)}`, label: <span>{m.alias} <Typography.Text type="secondary" style={{ fontSize: 12 }}>{m.provider}/{m.model}</Typography.Text></span> })) });
    }
    if (q) groups.push({ label: 'Requests', options: [{ value: `go:/history?q=${encodeURIComponent(query.trim())}`, label: <span><SearchOutlined /> Search request history for “{query.trim()}”</span> }] });
    return groups;
  }, [items, query, snap]);

  const onSelect = (value: string) => {
    if (value.startsWith('go:')) navigate(value.slice(3));
    setQuery('');
    searchRef.current?.blur();
  };

  const border = `1px solid ${token.colorBorderSecondary}`;
  return (
    <Layout style={{ minHeight: '100vh', background: token.colorBgLayout }}>
      <Sider
        width={232}
        collapsedWidth={68}
        collapsed={collapsed}
        trigger={null}
        theme="light"
        style={{ background: token.colorBgContainer, borderRight: border, position: 'sticky', top: 0, height: '100vh', overflow: 'auto' }}
      >
        <div style={{ height: 60, display: 'flex', alignItems: 'center', gap: 10, padding: collapsed ? '0 0 0 20px' : '0 20px', borderBottom: border }}>
          <img src="/logo.svg" alt="" style={{ height: 28, flex: 'none' }} />
          {!collapsed && (
            <Typography.Text strong style={{ fontSize: 15, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {settings['ui.projectName']}
            </Typography.Text>
          )}
        </div>
        <Menu
          mode="inline"
          selectedKeys={active ? [active.path] : []}
          style={{ background: 'transparent', borderInlineEnd: 0, padding: 8 }}
          items={items.map((n) => ({ key: n.path, icon: n.icon, label: n.label }))}
          onClick={(e) => navigate(e.key)}
        />
      </Sider>
      <Layout style={{ background: token.colorBgLayout, minWidth: 0 }}>
        <Header
          style={{
            height: 60, lineHeight: 'normal', display: 'flex', alignItems: 'center', gap: 16, padding: '0 20px',
            background: token.colorBgContainer, borderBottom: border, position: 'sticky', top: 0, zIndex: 10,
          }}
        >
          <Button type="text" icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />} onClick={() => setCollapsed((c) => !c)} aria-label="Toggle sidebar" />
          <div style={{ display: collapsed ? 'flex' : 'none', alignItems: 'center', gap: 8 }}>
            <Typography.Text strong>{settings['ui.projectName']}</Typography.Text>
          </div>
          <AutoComplete
            style={{ width: 'min(420px, 40vw)' }}
            options={options}
            value={query}
            onChange={setQuery}
            onSelect={onSelect}
            onFocus={loadSnap}
            popupMatchSelectWidth={480}
          >
            <Input
              ref={searchRef}
              allowClear
              prefix={<SearchOutlined />}
              suffix={<Tag style={{ margin: 0, fontSize: 11 }}>/</Tag>}
              placeholder="Search pages, providers, models, requests"
              onPressEnter={() => query.trim() && onSelect(`go:/history?q=${encodeURIComponent(query.trim())}`)}
            />
          </AutoComplete>
          <div style={{ flex: 1 }} />
          <HeaderWidget />
          <Dropdown
            trigger={['click']}
            menu={{
              items: [
                { key: 'who', disabled: true, label: <span>Signed in as <b>{user?.username}</b> ({user?.role})</span> },
                { type: 'divider' },
                { key: 'account', icon: <UserOutlined />, label: 'Account and password', onClick: () => navigate('/settings/account') },
                { key: 'logout', icon: <LogoutOutlined />, danger: true, label: 'Sign out', onClick: () => void logout() },
              ],
            }}
          >
            <Button type="text" style={{ display: 'flex', alignItems: 'center', gap: 8, height: 40 }}>
              <Avatar size={28} style={{ background: token.colorPrimary }}>{user?.username.slice(0, 1).toUpperCase()}</Avatar>
              {!collapsed && <span>{user?.username}</span>}
              <DownOutlined style={{ fontSize: 10 }} />
            </Button>
          </Dropdown>
        </Header>
        <Content style={{ padding: '24px 32px 48px', minWidth: 0 }}>
          <div style={{ maxWidth: 1440, margin: '0 auto' }}>
            <Outlet />
          </div>
        </Content>
      </Layout>
    </Layout>
  );
}
