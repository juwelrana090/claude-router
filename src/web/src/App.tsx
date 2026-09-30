import { Result, Spin } from 'antd';
import { Navigate, Route, Routes } from 'react-router-dom';
import { AppSettingsProvider } from './appSettings';
import { useAuth } from './auth';
import AppShell from './layout/AppShell';
import CatalogPage from './pages/Catalog';
import HistoryPage from './pages/History';
import InstructionsPage from './pages/Instructions';
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
            <Route path="catalog" element={<CatalogPage />} />
            <Route path="instructions" element={<InstructionsPage />} />
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
