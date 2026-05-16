// =====================================================================
// Supabase client singleton.
//
// Uses the project's anon key. Auth, RLS, and server-side RPCs do the
// heavy lifting; this client is shared across sync, realtime, auth.
//
// Storage key is namespaced so multiple Supabase apps on the same
// origin do not collide.
// =====================================================================

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const url      = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey  = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

if (!url || !anonKey) {
  // Fail fast & loud — missing env vars produce extremely confusing
  // 401 chains downstream otherwise.
  // eslint-disable-next-line no-console
  console.error('[supabase] Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY');
}

export const supabase: SupabaseClient = createClient(
  url ?? 'http://localhost:54321',
  anonKey ?? 'public-anon-key',
  {
    auth: {
      storageKey: 'alfahad.auth',
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
    },
    realtime: {
      params: { eventsPerSecond: 5 },
    },
    global: {
      headers: { 'x-app': 'alfahad-ice-pwa' },
    },
  },
);
