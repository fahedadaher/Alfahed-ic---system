// =====================================================================
// RequiresOnline. Wraps online-only actions: when offline, renders a
// muted explanation with the wrapped element disabled. Server-side
// online-only enforcement still runs (sync engine refuses to enqueue),
// but this gives users immediate feedback before they tap.
// =====================================================================

import { cloneElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { useOnline } from './network-monitor';

interface RequiresOnlineProps {
  children: ReactNode;
  /** Tooltip / aria-label shown when offline. */
  offlineHint?: string;
}

export function RequiresOnline({ children, offlineHint = 'Requires internet' }: RequiresOnlineProps) {
  const online = useOnline();
  if (online) return <>{children}</>;
  if (!isValidElement(children)) return <>{children}</>;

  // Disable the element and add a hint title.
  return cloneElement(children as ReactElement<any>, {
    disabled: true,
    title: offlineHint,
    'aria-disabled': true,
    style: { ...(children.props.style ?? {}), opacity: 0.5, cursor: 'not-allowed' },
  });
}
