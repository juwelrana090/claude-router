// antd v5 + React 19 compatibility patch (static message/notification/Modal APIs).
// Must be imported exactly once, before any antd component renders.
import '@ant-design/v5-patch-for-react-19';
import { ThemeProvider } from '@lobehub/ui';
import { ConfigProvider, theme as antdTheme } from 'antd';
import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { GLOBAL_CSS, buildTheme, cssVars } from './designTokens';
import { ThemeModeProvider, loadThemeMode, saveThemeMode, type ThemeMode } from './theme';

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('#root element not found');

function Root() {
  const [mode, setMode] = useState<ThemeMode>(loadThemeMode);

  return (
    <ThemeModeProvider
      mode={mode}
      setMode={(next) => {
        setMode(next);
        saveThemeMode(next);
      }}
    >
      <ConfigProvider
        theme={{
          algorithm: mode === 'dark' ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
          ...buildTheme(mode),
        }}
      >
        <style>{cssVars(mode) + GLOBAL_CSS}</style>
        {/* @lobehub/ui ThemeProvider must sit inside antd ConfigProvider. */}
        <ThemeProvider
          themeMode={mode}
          defaultThemeMode="dark"
          enableCustomFonts={false}
          theme={buildTheme(mode)}
          onThemeModeChange={(next) => {
            if (next === 'dark' || next === 'light') setMode(next);
          }}
        >
          <App />
        </ThemeProvider>
      </ConfigProvider>
    </ThemeModeProvider>
  );
}

createRoot(rootElement).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
