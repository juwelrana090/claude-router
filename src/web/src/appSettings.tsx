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
