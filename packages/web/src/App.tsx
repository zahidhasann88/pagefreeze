import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import { Layout } from './components/Layout.js';
import { LoadingState } from './components/ui.js';
import { useMe } from './api/hooks.js';
import { LoginPage } from './pages/LoginPage.js';
import { DashboardPage } from './pages/DashboardPage.js';
import { MonitorFormPage } from './pages/MonitorFormPage.js';
import { MonitorDetailPage } from './pages/MonitorDetailPage.js';
import { ChangeViewerPage } from './pages/ChangeViewerPage.js';
import { ComparePage } from './pages/ComparePage.js';
import { SettingsPage } from './pages/SettingsPage.js';
import { SharePage } from './pages/SharePage.js';

/**
 * TanStack Query client.
 *
 * Retries are limited to one and never applied to 4xx responses: a validation error or a
 * 404 will not become correct on its own, and retrying it only makes the UI feel slow.
 */
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (failureCount, error) => {
        const status = (error as { status?: number })?.status;
        if (status && status >= 400 && status < 500) return false;
        return failureCount < 1;
      },
      refetchOnWindowFocus: false,
      staleTime: 5_000,
    },
    mutations: { retry: false },
  },
});

/** Gate that keeps unauthenticated users out of every page except /login and /share. */
function RequireAuth({ children }: { children: ReactNode }) {
  const location = useLocation();
  const { data: me, isLoading, isError } = useMe();

  if (isLoading) return <LoadingState label="Checking session…" />;

  if (isError || !me) {
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }

  return <>{children}</>;
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <RequireAuth>
      <Layout>{children}</Layout>
    </RequireAuth>
  );
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          {/* Public: the share viewer is reachable without an account by design. */}
          <Route path="/share/:token" element={<SharePage />} />
          <Route path="/login" element={<LoginPage />} />

          <Route
            path="/"
            element={
              <Shell>
                <DashboardPage />
              </Shell>
            }
          />
          <Route
            path="/monitors/new"
            element={
              <Shell>
                <MonitorFormPage />
              </Shell>
            }
          />
          <Route
            path="/monitors/:monitorId"
            element={
              <Shell>
                <MonitorDetailPage />
              </Shell>
            }
          />
          <Route
            path="/monitors/:monitorId/edit"
            element={
              <Shell>
                <MonitorFormPage />
              </Shell>
            }
          />
          <Route
            path="/monitors/:monitorId/changes/:changeId"
            element={
              <Shell>
                <ChangeViewerPage />
              </Shell>
            }
          />
          <Route
            path="/monitors/:monitorId/compare"
            element={
              <Shell>
                <ComparePage />
              </Shell>
            }
          />
          <Route
            path="/settings"
            element={
              <Shell>
                <SettingsPage />
              </Shell>
            }
          />

          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
