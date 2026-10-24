// =====================================================================
// App bootstrap.
//
// Order matters:
//   1. Register sync handlers (so any drain triggered during start()
//      finds them).
//   2. Start the sync engine (network monitor + outbox drain loop).
//   3. Wire service worker — register, handle SKIP_WAITING, listen for
//      DRAIN_OUTBOX broadcasts.
//   4. After auth resolves, kick a pull and start realtime.
//   5. Render React.
// =====================================================================

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';

import { syncEngine } from './lib/sync/sync-engine';
import { registerSyncHandlers } from './lib/sync/handlers';
import { startRealtime } from './lib/sync/realtime';
import { pullAll } from './lib/sync/pull-sync';
import { networkMonitor } from './lib/network/network-monitor';

import { AuthProvider, useAuth } from './lib/auth/AuthProvider';
import { AppShell } from './components/layout/AppShell';
import { LoginPage } from './pages/LoginPage';
import { DriverHome } from './pages/driver/DriverHome';
import { SalesPage } from './pages/driver/SalesPage';
import { ReturnsPage } from './pages/driver/ReturnsPage';
import { CloseTripPage } from './pages/driver/CloseTripPage';
import { CashierHome } from './pages/cashier/CashierHome';
import { ManagerHome } from './pages/manager/ManagerHome';
import { LoadVehiclePage } from './pages/manager/LoadVehiclePage';
import { AccountantHome } from './pages/accountant/AccountantHome';
import { OwnerHome } from './pages/owner/OwnerHome';
import { SyncQueuePage } from './pages/SyncQueuePage';
import { AmpSubscriptionsPage } from './pages/amps/AmpSubscriptionsPage';
import { AmpSubscriptionDetailPage } from './pages/amps/AmpSubscriptionDetailPage';
import { MeterHealthPage } from './pages/amps/MeterHealthPage';
import { RequirePermission } from './lib/auth/role-guard';

import './styles/global.css';

// ---------------------------------------------------------------------
// 1–2. Sync engine & handlers.
// ---------------------------------------------------------------------
registerSyncHandlers();
void syncEngine.start();

// ---------------------------------------------------------------------
// 3. Service worker — register and wire control messages.
// ---------------------------------------------------------------------
async function bootstrapServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  try {
    // vite-plugin-pwa exposes registerSW from the virtual module.
    const { registerSW } = await import('virtual:pwa-register');
    const updateSW = registerSW({
      immediate: true,
      onNeedRefresh() {
        // A new version is ready; prompt update non-disruptively.
        if (typeof window !== 'undefined' &&
            window.confirm('New version available. Reload now?')) {
          void updateSW(true);
        }
      },
      onOfflineReady() {
        // eslint-disable-next-line no-console
        console.log('[pwa] ready for offline use');
      },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[pwa] service worker registration failed', err);
  }

  navigator.serviceWorker.addEventListener('message', evt => {
    if (evt.data?.type === 'DRAIN_OUTBOX') void syncEngine.drain();
  });
}
void bootstrapServiceWorker();

// ---------------------------------------------------------------------
// 4. Realtime + pull, after the network is up.
// ---------------------------------------------------------------------
networkMonitor.subscribe(online => {
  if (online) {
    void pullAll();
    startRealtime();
  }
});
if (networkMonitor.online) {
  void pullAll();
  startRealtime();
}

// ---------------------------------------------------------------------
// 5. Router. Each role gets its own home.
// ---------------------------------------------------------------------
function RoleRouter() {
  const { loading, profile } = useAuth();
  if (loading) return <div className="centered"><span>Loading…</span></div>;
  if (!profile) return <LoginPage />;

  const home = (() => {
    switch (profile.role) {
      case 'driver':           return <DriverHome />;
      case 'cashier':          return <CashierHome />;
      case 'factory_manager':  return <ManagerHome />;
      case 'accountant':       return <AccountantHome />;
      case 'owner':            return <OwnerHome />;
      default:                 return <div className="centered">Unknown role</div>;
    }
  })();

  return (
    <AppShell>
      <Routes>
        <Route path="/" element={home} />
        <Route path="/sales/new"     element={<SalesPage />} />
        <Route path="/returns/new"   element={<ReturnsPage />} />
        <Route path="/trip/close"    element={<CloseTripPage />} />
        <Route path="/manager/load"  element={<LoadVehiclePage />} />
        <Route path="/sync"          element={<SyncQueuePage />} />
        <Route path="/amps"          element={<RequirePermission perm="amp.view"><AmpSubscriptionsPage /></RequirePermission>} />
        <Route path="/amps/health"   element={<RequirePermission perm="amp.view"><MeterHealthPage /></RequirePermission>} />
        <Route path="/amps/:id"      element={<RequirePermission perm="amp.view"><AmpSubscriptionDetailPage /></RequirePermission>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AppShell>
  );
}

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('#root element not found');

createRoot(rootEl).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <RoleRouter />
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
);
