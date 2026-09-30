# 02 — Web app shell: sidebar layout, sign-in page, users, one URL per page

**Run after 01.** Changes `src/web/` only.

## What this step adds and why

- **Left sidebar** (Live, History, Providers, Models, Usage, Users, Settings) with the logo and project name on top; collapsible.
- **Top bar**: logo/name when the sidebar is collapsed, a **global search** (press `/` or Ctrl+K — finds pages, providers, models and jumps to request history), the live running-request widget, theme switch and a user menu (account, sign out).
- **Sign-in page** and the **first-run "create admin"** form; **Users page** (admins add users, change role, disable, reset password, delete).
- **One URL per page** (`/ui/live`, `/ui/history`, `/ui/providers`, `/ui/models`, `/ui/usage`, `/ui/users`, `/ui/settings/<tab>`), using `react-router-dom`. A refresh, a bookmark or the back button lands on the same page. A deep link while signed out returns to that page after sign-in.
- The old "ROUTER_KEY required" browser prompt is gone; `api.ts` no longer handles keys at all. A 401 just shows the sign-in page.
- `format.ts`: one set of number formatters so the same value reads the same everywhere (58,761,495 → `58.8M`, exact value in tooltips).

## How to work (read this first)

- This file is **complete**. Everything you need is below. **Do not open, search or read any other file or folder.**
  If a step says "replace the whole file" you do not need to read the old one. If a step is a diff, open **only that one file** to apply it.
- Diffs are unified diffs with 3 lines of context. Apply each from the repo root with
  `git apply --ignore-whitespace --whitespace=nowarn <file.patch>` (save the block to a `.patch` file first), or edit by hand: `-` lines are removed, `+` lines are added, everything else is context.
  If a hunk does not match because the line already looks like the `+` version, skip that hunk and say so.
- Files in this repo use Windows line endings (CRLF). Keep each existing file's line endings. New files may use either.
- Do not change anything that is not listed. No refactors, no renames, no formatting changes.
- Never print, log, or commit `.env` values.
- When done, run the verification commands at the end and paste their **real output**. If one fails, fix only what the failure points to, then re-run it.

## Steps

### Step 1 — Add the dependency

In `src/web/package.json`, add to `dependencies` (keep alphabetical order): `"react-router-dom": "^7.18.4"`. Then from the **repo root** run `npm install` (one shared install; do not run npm inside `src/web`).

### Step 2 — Create these new files

### `src/web/src/format.ts` — NEW file

````ts
/** Number/time formatting shared by every page so the same value always reads the same way. */

const UNITS: [number, string][] = [
  [1e12, 'T'],
  [1e9, 'B'],
  [1e6, 'M'],
  [1e3, 'K'],
];

/** 58,761,495 -> "58.8M". Small numbers stay exact. Use fmtExact for the tooltip. */
export function fmtCompact(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  for (const [size, unit] of UNITS) {
    if (abs >= size) {
      const v = n / size;
      return `${v >= 100 ? Math.round(v) : v >= 10 ? v.toFixed(1) : v.toFixed(2)}${unit}`.replace(/\.0+([A-Z])$/, '$1');
    }
  }
  return String(Math.round(n));
}

export function fmtExact(n: number | null | undefined): string {
  return n == null || !Number.isFinite(n) ? '—' : n.toLocaleString('en-US');
}

/** "58.8 million" for people who do not think in K/M/B at a glance. */
export function fmtWords(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '';
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(2)} billion`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(2)} million`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1)} thousand`;
  return String(Math.round(n));
}

export function fmtUsd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  if (n === 0) return '$0.00';
  if (Math.abs(n) < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

export function fmtPct(n: number | null | undefined, digits = 1): string {
  return n == null || !Number.isFinite(n) ? '—' : `${n.toFixed(digits)}%`;
}

export function fmtMs(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return '—';
  if (ms >= 60_000) return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
  if (ms >= 10_000) return `${(ms / 1000).toFixed(1)} s`;
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)} s`;
  return `${Math.round(ms)} ms`;
}

export function fmtTps(tps: number | null | undefined): string {
  if (tps == null || !Number.isFinite(tps)) return '—';
  return tps >= 10 ? String(Math.round(tps)) : tps.toFixed(1);
}

/** mm:ss, or h:mm:ss past one hour. */
export function fmtClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const ss = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${String(m).padStart(2, '0')}:${ss}`;
}

export function fmtTime(ts: number | null | undefined): string {
  if (!ts || !Number.isFinite(ts)) return '—';
  return new Date(ts).toLocaleTimeString('en-GB', { hour12: false });
}

export function fmtDateTime(ts: number | null | undefined): string {
  if (!ts || !Number.isFinite(ts)) return '—';
  const d = new Date(ts);
  return `${d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })} ${d.toLocaleTimeString('en-GB', { hour12: false })}`;
}

export function fmtBytes(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  if (n >= 1 << 30) return `${(n / (1 << 30)).toFixed(2)} GB`;
  if (n >= 1 << 20) return `${(n / (1 << 20)).toFixed(1)} MB`;
  if (n >= 1 << 10) return `${(n / (1 << 10)).toFixed(0)} KB`;
  return `${n} B`;
}

export function fmtUptime(sec: number): string {
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m ${sec % 60}s`;
}
````

### `src/web/src/auth.tsx` — NEW file

````tsx
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { UNAUTHORIZED_EVENT, api } from './api';

export interface AuthUser {
  id: number;
  username: string;
  role: 'admin' | 'user';
}

interface AuthState {
  loading: boolean;
  needsSetup: boolean;
  user: AuthUser | null;
  isAdmin: boolean;
  login: (username: string, password: string) => Promise<void>;
  setup: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [user, setUser] = useState<AuthUser | null>(null);

  const refresh = useCallback(async () => {
    try {
      const s = await api<{ needsSetup: boolean; user: AuthUser | null }>('/admin/auth/status');
      setNeedsSetup(s.needsSetup);
      setUser(s.user);
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const onExpired = () => setUser(null);
    window.addEventListener(UNAUTHORIZED_EVENT, onExpired);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onExpired);
  }, [refresh]);

  const value = useMemo<AuthState>(
    () => ({
      loading,
      needsSetup,
      user,
      isAdmin: user?.role === 'admin',
      refresh,
      login: async (username, password) => {
        const r = await api<{ user: AuthUser }>('/admin/auth/login', {
          method: 'POST',
          body: JSON.stringify({ username, password }),
        });
        setUser(r.user);
      },
      setup: async (username, password) => {
        const r = await api<{ user: AuthUser }>('/admin/auth/setup', {
          method: 'POST',
          body: JSON.stringify({ username, password }),
        });
        setNeedsSetup(false);
        setUser(r.user);
      },
      logout: async () => {
        try {
          await api('/admin/auth/logout', { method: 'POST', body: '{}' });
        } finally {
          setUser(null);
        }
      },
    }),
    [loading, needsSetup, user, refresh],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth outside AuthProvider');
  return v;
}
````

### `src/web/src/appSettings.tsx` — NEW file

````tsx
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api } from './api';

export interface AppSettings {
  'history.retentionDays': number;
  'context.warnTokens': number;
  'pricing.peakMultiplier': number;
  'ui.projectName': string;
}

const DEFAULTS: AppSettings = {
  'history.retentionDays': 30,
  'context.warnTokens': 100_000,
  'pricing.peakMultiplier': 2,
  'ui.projectName': 'Claude Router',
};

interface Ctx {
  settings: AppSettings;
  reload: () => Promise<void>;
}
const C = createContext<Ctx>({ settings: DEFAULTS, reload: async () => {} });

export function AppSettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<AppSettings>(DEFAULTS);
  const reload = useCallback(async () => {
    try {
      const r = await api<{ settings: AppSettings }>('/admin/app-settings');
      setSettings({ ...DEFAULTS, ...r.settings });
    } catch {
      /* keep defaults */
    }
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);
  const value = useMemo(() => ({ settings, reload }), [settings, reload]);
  return <C.Provider value={value}>{children}</C.Provider>;
}

export const useAppSettings = (): Ctx => useContext(C);
````

### `src/web/src/layout/AppShell.tsx` — NEW file

````tsx
import {
  ApiOutlined,
  BarChartOutlined,
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
  { path: '/models', label: 'Models', icon: <DeploymentUnitOutlined />, hint: 'Aliases, fallbacks and prices' },
  { path: '/usage', label: 'Usage', icon: <BarChartOutlined />, hint: 'Tokens, cost and context size' },
  { path: '/users', label: 'Users', icon: <TeamOutlined />, adminOnly: true, hint: 'Who can sign in' },
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
````

### `src/web/src/pages/Login.tsx` — NEW file

````tsx
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
````

### `src/web/src/pages/Users.tsx` — NEW file

````tsx
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
````

### Step 3 — Replace these two files completely

### `src/web/src/api.ts` — REPLACE the whole file

````ts
/**
 * HTTP + SSE client for the claude-router admin API.
 *
 * Auth: the browser signs in once (username + password) and the server keeps an HttpOnly session
 * cookie, so fetch and EventSource are authenticated automatically. There is no key prompt any more.
 * A 401 fires the "router:unauthorized" window event; AuthProvider reacts by showing the sign-in page.
 */
import type { EtaEvent, EtaSnapshot, Snapshot, UsageRange, UsageSummary } from './types';

export const UNAUTHORIZED_EVENT = 'router:unauthorized';

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

/** Fetch JSON from the admin API. Errors carry the server's field-level reason. */
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const method = init.method ?? 'GET';
  // Non-GET calls need a JSON content type (the server refuses form posts); send one even without a body.
  if (method !== 'GET' && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');

  const res = await fetch(path, { ...init, headers, credentials: 'same-origin' });

  if (!res.ok) {
    let detail = res.statusText;
    try {
      const data = await res.json();
      const fieldMsgs = Array.isArray(data?.errors)
        ? data.errors.map((e: { field: string; message: string }) => `${e.field}: ${e.message}`).join('; ')
        : '';
      detail = fieldMsgs || data?.error?.message || detail;
    } catch {
      // body wasn't JSON — keep the generic status line
    }
    if (res.status === 401 && !path.startsWith('/admin/auth/')) {
      window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
    }
    throw new ApiError(res.status, `${method} ${path} failed: ${res.status} ${detail}`);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

// ---------- Contract endpoints ----------

export const fetchSnapshot = (): Promise<Snapshot> => api<Snapshot>('/admin/snapshot');
export const fetchEtaSnapshot = (): Promise<EtaSnapshot> => api<EtaSnapshot>('/admin/eta');
export const fetchUsageSummary = (range: UsageRange): Promise<UsageSummary> =>
  api<UsageSummary>(`/admin/usage/summary?range=${encodeURIComponent(range)}`);

// ---------- Live SSE (/admin/events) ----------

export type EtaEventHandler = (event: EtaEvent) => void;

/**
 * Subscribe to the "eta" SSE stream with auto-reconnect (exponential backoff, capped at 15s).
 * The session cookie authenticates it. Returns an unsubscribe function.
 */
export function subscribeEta(handler: EtaEventHandler): () => void {
  let source: EventSource | null = null;
  let reconnectTimer: number | undefined;
  let attempt = 0;
  let stopped = false;

  const connect = () => {
    if (stopped) return;
    source = new EventSource('/admin/events');
    source.addEventListener('eta', (ev: Event) => {
      attempt = 0;
      try {
        handler(JSON.parse((ev as MessageEvent).data) as EtaEvent);
      } catch {
        // malformed payload; skip it
      }
    });
    source.onerror = () => {
      if (stopped) return;
      source?.close();
      attempt += 1;
      reconnectTimer = window.setTimeout(connect, Math.min(1000 * 2 ** attempt, 15000));
    };
  };
  connect();

  return () => {
    stopped = true;
    if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
    source?.close();
  };
}
````

### `src/web/src/App.tsx` — REPLACE the whole file

````tsx
import { Result, Spin } from 'antd';
import { Navigate, Route, Routes } from 'react-router-dom';
import { AppSettingsProvider } from './appSettings';
import { useAuth } from './auth';
import AppShell from './layout/AppShell';
import HistoryPage from './pages/History';
import LivePage from './pages/Live';
import LoginPage from './pages/Login';
import ModelsPage from './pages/Models';
import ProvidersPage from './pages/Providers';
import SettingsPage from './pages/Settings';
import UsagePage from './pages/Usage';
import UsersPage from './pages/Users';

/**
 * One URL per page (/ui/live, /ui/history, /ui/providers, ...), so a refresh, a bookmark or the
 * browser's back button always lands on the same page.
 */
export default function App() {
  const { loading, user } = useAuth();
  if (loading) return <Spin fullscreen />;
  if (!user) return <LoginPage />;
  return (
    <AppSettingsProvider>
      <Routes>
        <Route element={<AppShell />}>
          <Route index element={<Navigate to="/live" replace />} />
          <Route path="live" element={<LivePage />} />
          <Route path="history" element={<HistoryPage />} />
          <Route path="providers" element={<ProvidersPage />} />
          <Route path="models" element={<ModelsPage />} />
          <Route path="usage" element={<UsagePage />} />
          <Route path="users" element={<UsersPage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="settings/:tab" element={<SettingsPage />} />
          <Route path="*" element={<Result status="404" title="Page not found" />} />
        </Route>
      </Routes>
    </AppSettingsProvider>
  );
}
````

### Step 4 — Apply these diffs

### `src/web/src/main.tsx` — Router + AuthProvider around the app

````diff
--- a/src/web/src/main.tsx
+++ b/src/web/src/main.tsx
@@ -5,7 +5,9 @@
 import { ConfigProvider, theme as antdTheme } from 'antd';
 import { StrictMode, useState } from 'react';
 import { createRoot } from 'react-dom/client';
+import { BrowserRouter } from 'react-router-dom';
 import App from './App';
+import { AuthProvider } from './auth';
 import { GLOBAL_CSS, buildTheme, cssVars } from './designTokens';
 import { ThemeModeProvider, loadThemeMode, saveThemeMode, type ThemeMode } from './theme';
 
@@ -40,7 +42,11 @@
             if (next === 'dark' || next === 'light') setMode(next);
           }}
         >
-          <App />
+          <BrowserRouter basename="/ui">
+            <AuthProvider>
+              <App />
+            </AuthProvider>
+          </BrowserRouter>
         </ThemeProvider>
       </ConfigProvider>
     </ThemeModeProvider>
````

### `src/web/src/components/HeaderWidget.tsx` — api() no longer takes a retry flag

````diff
--- a/src/web/src/components/HeaderWidget.tsx
+++ b/src/web/src/components/HeaderWidget.tsx
@@ -79,9 +79,7 @@
   useEffect(() => {
     let disposed = false;
     const reconcile = (): void => {
-      // retry=false: the poll must not drive the key prompt (the pages do that
-      // at a saner cadence); it just reflects the stored key's health.
-      api<EtaSnapshot>('/admin/eta', {}, false)
+      api<EtaSnapshot>('/admin/eta')
         .then((snap) => {
           if (disposed) return;
           const at = Date.now();
````

### `src/web/src/types.ts` — history/insights types and token counts on the final live frame

````diff
--- a/src/web/src/types.ts
+++ b/src/web/src/types.ts
@@ -31,6 +31,13 @@
   /** Terminal only. Authoritative total duration. */
   durationMs?: number;
   failover?: boolean;
+  /** Terminal frames only. */
+  httpStatus?: number;
+  inTokens?: number;
+  cacheRead?: number;
+  cacheWrite?: number;
+  ctxTokens?: number;
+  cost?: number;
 }
 
 // ---------- Session totals ----------
@@ -197,3 +204,71 @@
   envName: string;
   value: string;
 }
+
+// ---------- Request history (GET /admin/requests) ----------
+
+export interface HistoryRow {
+  id: string;
+  sessionId: string | null;
+  alias: string;
+  provider: string;
+  model: string;
+  key: string | null;
+  status: number;
+  stream: boolean;
+  failover: boolean;
+  startedAt: number;
+  firstTokenAt: number | null;
+  endedAt: number;
+  durationMs: number | null;
+  ttftMs: number | null;
+  /** Fresh (uncached) input tokens. */
+  in: number;
+  out: number;
+  cacheRead: number;
+  cacheWrite: number;
+  /** Whole prompt size: in + cacheRead + cacheWrite. This is what every request re-sends. */
+  ctx: number;
+  cost: number;
+  tps: number | null;
+}
+
+export interface RunningRow {
+  id: string;
+  alias: string;
+  provider: string;
+  model: string;
+  key: string;
+  startedAt: number;
+  stream: boolean;
+  status: string;
+  failover: boolean;
+  outSoFar: number;
+  tokensPerSec: number | null;
+}
+
+export interface HistoryResponse {
+  rows: HistoryRow[];
+  hasMore: boolean;
+  total: number;
+  running: RunningRow[];
+}
+
+export interface Insights {
+  range: string;
+  warnTokens: number;
+  totals: {
+    requests: number;
+    errors: number;
+    fresh: number;
+    out: number;
+    cacheRead: number;
+    cacheWrite: number;
+    cost: number;
+    input: number;
+    cacheHitPct: number;
+  };
+  context: { avg: number; p50: number; p90: number; max: number; overWarn: number; compactions: number };
+  topSessions: { sessionId: string; requests: number; ctxTotal: number; maxCtx: number; startedAt: number; endedAt: number }[];
+  hourly: { t: number; requests: number; ctx: number; out: number; cacheRead: number }[];
+}
````

## Verify

```bash
cd src/web && npx tsc --noEmit    # expect: no output (03 is not applied yet, so if a file from 03 is missing you will see errors ONLY about History/RequestTable/Settings imports — finish 03 first, then run this)
```
Do the full check after step 03.
