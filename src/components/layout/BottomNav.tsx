// =====================================================================
// Mobile bottom navigation. Role-aware. Sticky to bottom with safe-area
// padding. Each role gets the 3–4 actions they reach for most.
//
// Badges:
//  - Sync: shows pending+failed count when > 0.
//  - Approvals: shows count of pending approvals visible to this role.
// =====================================================================

import { Link, useLocation } from 'react-router-dom';
import { useAuth } from '../../lib/auth/AuthProvider';
import { useLiveQuery, useSyncState } from '../../hooks/useLiveQuery';
import { db } from '../../lib/db/indexeddb';
import { useT } from '../../lib/i18n';
import type { UserRole } from '../../types/domain';

interface NavItem {
  to: string;
  label: string;
  icon: string;
  badge?: number | null;
}

export function BottomNav() {
  const { profile } = useAuth();
  const t = useT();
  const loc = useLocation();
  const sync = useSyncState();
  const role: UserRole | null = profile?.role ?? null;

  const pendingApprovals = useLiveQuery(async () => {
    if (!role) return 0;
    if (role === 'cashier') {
      return db.approvals.where('kind').equals('cashier').filter(a => a.status === 'pending').count();
    }
    if (role === 'factory_manager' || role === 'owner') {
      return db.approvals.filter(a => a.status === 'pending').count();
    }
    return 0;
  }, [role]) ?? 0;

  const openMeterAlerts = useLiveQuery(async () => {
    if (role !== 'owner' && role !== 'factory_manager' && role !== 'accountant') return 0;
    return db.meter_alerts.where('status').equals('open').count();
  }, [role]) ?? 0;

  if (!role) return null;

  const syncBadge = sync.pending + sync.failed;
  const items = buildItems(role, t, syncBadge, pendingApprovals, openMeterAlerts);

  return (
    <nav className="bottom-nav" aria-label="Primary">
      {items.map(it => {
        const active = loc.pathname === it.to || (it.to !== '/' && loc.pathname.startsWith(it.to));
        return (
          <Link key={it.to} to={it.to} className={`bn-item ${active ? 'active' : ''}`}>
            <span className="bn-icon" aria-hidden="true">{it.icon}</span>
            <span className="bn-label">{it.label}</span>
            {it.badge != null && it.badge > 0 && (
              <span className="bn-badge" aria-label={`${it.badge}`}>{it.badge > 99 ? '99+' : it.badge}</span>
            )}
          </Link>
        );
      })}
    </nav>
  );
}

function buildItems(
  role: UserRole,
  t: (k: string, p?: Record<string, string | number>) => string,
  syncBadge: number,
  approvalBadge: number,
  meterAlertBadge: number,
): NavItem[] {
  const home: NavItem = { to: '/', label: t('nav.home'), icon: '⌂' };
  const amps: NavItem = { to: '/amps', label: t('nav.amps'), icon: '⚡', badge: meterAlertBadge };
  const sync: NavItem = { to: '/sync', label: t('nav.sync'), icon: '⟳', badge: syncBadge };

  switch (role) {
    case 'driver':
      return [
        home,
        { to: '/sales/new',   label: t('nav.sales'),   icon: '＋' },
        { to: '/returns/new', label: t('nav.returns'), icon: '↩' },
        sync,
      ];
    case 'cashier':
      return [
        home,
        { to: '/', label: t('nav.approvals'), icon: '✓', badge: approvalBadge },
        sync,
      ];
    case 'factory_manager':
      return [
        home,
        { to: '/manager/load', label: t('nav.inventory'), icon: '☰' },
        { to: '/', label: t('nav.approvals'), icon: '✓', badge: approvalBadge },
        amps,
        sync,
      ];
    case 'accountant':
      return [home, { to: '/', label: t('nav.reports'), icon: '∑' }, amps, sync];
    case 'owner':
      return [
        home,
        { to: '/', label: t('nav.approvals'), icon: '✓', badge: approvalBadge },
        { to: '/', label: t('nav.reports'),   icon: '∑' },
        amps,
        sync,
      ];
  }
}
