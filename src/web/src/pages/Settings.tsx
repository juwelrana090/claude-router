/**
 * Settings page: theme toggle, connection probes (snapshot + eta endpoints),
 * ROUTER_KEY re-entry, and Claude Code statusline setup instructions.
 */
import { Snippet } from '@lobehub/ui';
import { Alert, Button, Card, Input, Segmented, Space, Tag, Typography, message } from 'antd';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { clearRouterKey, fetchEtaSnapshot, fetchSnapshot, getRouterKey, setRouterKey } from '../api';
import { useThemeToggle } from '../theme';

interface ProbeState {
  status: 'checking' | 'ok' | 'fail';
  detail?: string;
}

const CHECKING: ProbeState = { status: 'checking' };

const reasonText = (reason: unknown): string =>
  reason instanceof Error ? reason.message : String(reason);

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <Card variant="borderless" styles={{ body: { padding: 16 } }}>
      <Typography.Title level={5} style={{ marginTop: 0, marginBottom: description ? 2 : 12 }}>
        {title}
      </Typography.Title>
      {description ? (
        <Typography.Text type="secondary" style={{ display: 'block', marginBottom: 12 }}>
          {description}
        </Typography.Text>
      ) : null}
      {children}
    </Card>
  );
}

function ProbeRow({ name, state }: { name: string; state: ProbeState }) {
  const tag =
    state.status === 'ok' ? (
      <Tag color="green">ok</Tag>
    ) : state.status === 'fail' ? (
      <Tag color="red">failed</Tag>
    ) : (
      <Tag>checking…</Tag>
    );
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
      <span style={{ minWidth: 140 }}>{name}</span>
      {tag}
      {state.detail ? (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {state.detail}
        </Typography.Text>
      ) : null}
    </div>
  );
}

const STATUSLINE_SNIPPET =
  '{"statusLine": { "type": "command", "command": "node \\"/absolute/path/to/claude-router/scripts/statusline.mjs\\"" } }';

export default function SettingsPage() {
  const { mode, toggle } = useThemeToggle();

  const [snapshotProbe, setSnapshotProbe] = useState<ProbeState>(CHECKING);
  const [etaProbe, setEtaProbe] = useState<ProbeState>(CHECKING);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  const [probing, setProbing] = useState(false);

  const [keyInput, setKeyInput] = useState('');
  const [keyStored, setKeyStored] = useState(() => getRouterKey() != null);

  const runProbes = useCallback(async () => {
    setProbing(true);
    setSnapshotProbe(CHECKING);
    setEtaProbe(CHECKING);
    const [snapRes, etaRes] = await Promise.allSettled([fetchSnapshot(), fetchEtaSnapshot()]);
    if (snapRes.status === 'fulfilled') {
      const s = snapRes.value;
      setSnapshotProbe({
        status: 'ok',
        detail: `v${s.version} · ${s.providers.length} providers · ${s.models.length} models`,
      });
    } else {
      setSnapshotProbe({ status: 'fail', detail: reasonText(snapRes.reason) });
    }
    if (etaRes.status === 'fulfilled') {
      setEtaProbe({ status: 'ok', detail: `${etaRes.value.running.length} running request(s)` });
    } else {
      setEtaProbe({ status: 'fail', detail: reasonText(etaRes.reason) });
    }
    setCheckedAt(Date.now());
    setProbing(false);
  }, []);

  useEffect(() => {
    void runProbes();
  }, [runProbes]);

  const saveKey = useCallback(async () => {
    const key = keyInput.trim();
    if (!key) {
      message.warning('Enter a key first.');
      return;
    }
    setRouterKey(key);
    setKeyInput('');
    setKeyStored(true);
    message.success('Router key saved for this tab.');
    await runProbes();
    message.info('Probes re-ran with the new key — check connection status below.');
  }, [keyInput, runProbes]);

  const clearKey = useCallback(() => {
    clearRouterKey();
    setKeyStored(false);
    message.info('Router key cleared from this tab.');
    void runProbes();
  }, [runProbes]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 760 }}>
      <Section title="Appearance" description="Dark and light render the same data; the choice is stored per browser.">
        <Segmented
          options={[
            { label: 'Dark', value: 'dark' },
            { label: 'Light', value: 'light' },
          ]}
          value={mode}
          onChange={(v) => {
            if ((v === 'dark' || v === 'light') && v !== mode) toggle();
          }}
        />
      </Section>

      <Section
        title="Connection"
        description="Both admin endpoints must answer for the dashboard to work. Probes use the stored key."
      >
        <Space direction="vertical" size={8} style={{ width: '100%' }}>
          <ProbeRow name="GET /admin/snapshot" state={snapshotProbe} />
          <ProbeRow name="GET /admin/eta" state={etaProbe} />
          <Space>
            <Button size="small" onClick={() => void runProbes()} loading={probing}>
              Recheck
            </Button>
            {checkedAt ? (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                Last checked {new Date(checkedAt).toLocaleTimeString()}
              </Typography.Text>
            ) : null}
          </Space>
        </Space>
      </Section>

      <Section
        title="ROUTER_KEY"
        description="The key is kept in this tab's sessionStorage only and sent as the x-api-key header on every admin request. The live SSE stream passes it as a ?key= query parameter because EventSource cannot set headers."
      >
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          {!keyStored ? (
            <Alert
              type="warning"
              showIcon
              message="No key stored in this tab"
              description="Admin requests will fall back to a browser prompt until a key is saved here."
            />
          ) : null}
          <Space.Compact style={{ width: '100%', maxWidth: 480 }}>
            <Input.Password
              placeholder="ROUTER_KEY"
              value={keyInput}
              autoComplete="off"
              onChange={(e) => setKeyInput(e.target.value)}
              onPressEnter={() => void saveKey()}
            />
            <Button type="primary" onClick={() => void saveKey()}>
              Save
            </Button>
          </Space.Compact>
          <Space>
            <Button size="small" onClick={clearKey} disabled={!keyStored}>
              Clear stored key
            </Button>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {keyStored ? 'A key is set for this tab.' : 'No key set.'}
            </Typography.Text>
          </Space>
        </Space>
      </Section>

      <Section
        title="Claude Code statusline"
        description="Show provider/model, elapsed time, ETA, session tokens and session cost in the Claude Code status bar."
      >
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <div>
            <Typography.Text strong>1. Test it from the repo root</Typography.Text>
            <div style={{ marginTop: 6 }}>
              <Snippet language="bash" prefix="$">
                node scripts/statusline.mjs
              </Snippet>
            </div>
          </div>
          <div>
            <Typography.Text strong>
              2. Enable it in Claude Code settings (.claude/settings.json or ~/.claude/settings.json)
            </Typography.Text>
            <Typography.Text type="secondary" style={{ display: 'block', fontSize: 12, margin: '4px 0 6px' }}>
              Replace /absolute/path/to/claude-router with your real absolute repo path.
            </Typography.Text>
            <Snippet language="json">{STATUSLINE_SNIPPET}</Snippet>
          </div>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            The script reads ROUTER_PORT / ROUTER_KEY from the router .env (repo root, or ROUTER_HOME) and calls
            GET /admin/eta on 127.0.0.1. It never prints the key and always exits 0, showing "claude-router -
            offline" when the router is unreachable.
          </Typography.Text>
        </Space>
      </Section>
    </div>
  );
}
