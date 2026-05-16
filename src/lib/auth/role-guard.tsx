// =====================================================================
// Permission gate components. Render-prop style for both inline and
// route-level usage. Server RLS is the actual enforcer; this just keeps
// disallowed UI out of view.
// =====================================================================

import type { ReactNode } from 'react';
import { useAuth } from './AuthProvider';
import type { Permission } from './permissions';

interface RequireProps {
  perm?: Permission;
  any?: Permission[];
  fallback?: ReactNode;
  children: ReactNode;
}

export function RequirePermission({ perm, any, fallback = null, children }: RequireProps) {
  const auth = useAuth();
  const ok = perm ? auth.can(perm) : any ? auth.canAny(any) : true;
  return <>{ok ? children : fallback}</>;
}
