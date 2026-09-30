import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api } from './api';

export interface AppSettings {
  'history.retentionDays': number;
  'context.warnTokens': number;
  'pricing.peakMultiplier': number;
  'ui.projectName': string;
  'guard.mode': 'off' | 'shadow' | 'on';
  'guard.highTokens': number;
  'guard.lowTokens': number;
  'guard.keepRecent': number;
  'guard.minChars': number;
  'routing.failover': 'auto' | 'off';
  'routing.retries': number;
  'optimise.scope': 'auto' | 'always';
  'guard.trimInputs': boolean;
  'guard.trimPastes': boolean;
  'guard.pasteChars': number;
  'memory.mode': 'off' | 'shadow' | 'on';
  'memory.model': string;
  'memory.highTokens': number;
  'memory.lowTokens': number;
}

const DEFAULTS: AppSettings = {
  'history.retentionDays': 30,
  'context.warnTokens': 100_000,
  'pricing.peakMultiplier': 2,
  'ui.projectName': 'Claude Router',
  'guard.mode': 'shadow',
  'guard.highTokens': 90_000,
  'guard.lowTokens': 45_000,
  'guard.keepRecent': 6,
  'guard.minChars': 1200,
  'routing.failover': 'auto',
  'routing.retries': 2,
  'optimise.scope': 'auto',
  'guard.trimInputs': true,
  'guard.trimPastes': false,
  'guard.pasteChars': 12_000,
  'memory.mode': 'shadow',
  'memory.model': '',
  'memory.highTokens': 80_000,
  'memory.lowTokens': 35_000,
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
