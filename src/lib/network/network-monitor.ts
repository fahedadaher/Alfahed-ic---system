// =====================================================================
// Network monitor.
//
// `navigator.onLine` lies on captive portals and on networks where the
// device thinks it's connected but cannot reach the API. We combine it
// with a periodic HEAD probe of /healthz.json (a tiny static asset) to
// produce a real-world "online" signal.
//
// Subscribers can reactively re-render (e.g. offline banner) and the
// sync engine uses this to decide whether to drain the outbox.
// =====================================================================

import { useEffect, useState } from 'react';

type Listener = (online: boolean) => void;

const PROBE_URL      = '/healthz.json';
const PROBE_INTERVAL = 30_000;
const PROBE_TIMEOUT  = 6_000;

class NetworkMonitor {
  private _online: boolean = typeof navigator !== 'undefined' ? navigator.onLine : true;
  private listeners = new Set<Listener>();
  private timer: ReturnType<typeof setInterval> | null = null;

  start() {
    if (typeof window === 'undefined') return;
    window.addEventListener('online',  this.handleBrowserOnline);
    window.addEventListener('offline', this.handleBrowserOffline);

    // Active probe loop — guards against captive portals.
    this.timer = setInterval(() => { void this.probe(); }, PROBE_INTERVAL);
    void this.probe();
  }

  stop() {
    if (typeof window === 'undefined') return;
    window.removeEventListener('online',  this.handleBrowserOnline);
    window.removeEventListener('offline', this.handleBrowserOffline);
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  get online(): boolean { return this._online; }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  /** Force an immediate reachability probe (e.g. after user retries). */
  async refresh(): Promise<boolean> {
    return this.probe();
  }

  private handleBrowserOnline  = () => { void this.probe(); };
  private handleBrowserOffline = () => { this.set(false); };

  private async probe(): Promise<boolean> {
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      this.set(false);
      return false;
    }
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT);
      const res = await fetch(PROBE_URL, {
        method: 'HEAD',
        cache: 'no-store',
        signal: ctrl.signal,
      });
      clearTimeout(t);
      this.set(res.ok);
      return res.ok;
    } catch {
      this.set(false);
      return false;
    }
  }

  private set(value: boolean) {
    if (this._online === value) return;
    this._online = value;
    this.listeners.forEach(l => { try { l(value); } catch { /* ignore */ } });
  }
}

export const networkMonitor = new NetworkMonitor();

/** React hook for online/offline state. */
export function useOnline(): boolean {
  const [online, setOnline] = useState(networkMonitor.online);
  useEffect(() => networkMonitor.subscribe(setOnline), []);
  return online;
}
