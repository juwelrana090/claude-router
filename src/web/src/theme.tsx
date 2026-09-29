import { createContext, useCallback, useContext, useMemo, type ReactNode } from 'react';

export type ThemeMode = 'dark' | 'light';

const THEME_MODE_STORAGE_KEY = 'claude-router-theme-mode';

/** Stored theme mode; defaults to dark when unset or storage is unavailable. */
export function loadThemeMode(): ThemeMode {
  try {
    return localStorage.getItem(THEME_MODE_STORAGE_KEY) === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

export function saveThemeMode(mode: ThemeMode): void {
  try {
    localStorage.setItem(THEME_MODE_STORAGE_KEY, mode);
  } catch {
    // storage unavailable; toggle still works for the session
  }
}

interface ThemeModeContextValue {
  mode: ThemeMode;
  setMode: (mode: ThemeMode) => void;
}

const ThemeModeContext = createContext<ThemeModeContextValue | null>(null);

interface ThemeModeProviderProps extends ThemeModeContextValue {
  children: ReactNode;
}

/**
 * Exposes the active theme mode (and its toggle) to the component tree.
 * Persistence is handled by the root component in main.tsx.
 */
export function ThemeModeProvider({ mode, setMode, children }: ThemeModeProviderProps) {
  const value = useMemo(() => ({ mode, setMode }), [mode, setMode]);
  return <ThemeModeContext.Provider value={value}>{children}</ThemeModeContext.Provider>;
}

export function useThemeMode(): ThemeModeContextValue {
  const ctx = useContext(ThemeModeContext);
  if (!ctx) throw new Error('useThemeMode must be used inside ThemeModeProvider');
  return ctx;
}

/** Convenience hook for toggle buttons. */
export function useThemeToggle(): { mode: ThemeMode; toggle: () => void } {
  const { mode, setMode } = useThemeMode();
  const toggle = useCallback(() => setMode(mode === 'dark' ? 'light' : 'dark'), [mode, setMode]);
  return { mode, toggle };
}
