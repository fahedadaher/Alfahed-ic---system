// =====================================================================
// AuthProvider. Wraps the app with auth state.
//
// On mount:
//   1. Hydrate cached profile from Dexie (instant UI).
//   2. Refresh from Supabase (truth).
//   3. Persist user id and role to META so we can recover offline.
// =====================================================================

import {
  createContext, useCallback, useContext, useEffect, useMemo, useState,
  type ReactNode,
} from 'react';
import { supabase } from '../supabase/client';
import { db, setMeta, META_KEYS } from '../db/indexeddb';
import { can, canAny, type Permission } from './permissions';
import type { Profile, UserRole } from '../../types/domain';

interface AuthContextValue {
  loading: boolean;
  userId: string | null;
  profile: Profile | null;
  role: UserRole | null;
  signIn: (email: string, password: string) => Promise<{ error: string | null }>;
  signOut: () => Promise<void>;
  can: (perm: Permission) => boolean;
  canAny: (perms: Permission[]) => boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [userId,  setUserId]  = useState<string | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);

  const hydrateProfile = useCallback(async (uid: string) => {
    // Try cached profile first for instant UI on reopen.
    const cached = await db.profiles.get(uid);
    if (cached) setProfile(cached);

    // Refresh from server.
    const { data, error } = await supabase.from('profiles').select('*').eq('id', uid).single();
    if (!error && data) {
      const p = data as Profile;
      setProfile(p);
      await db.profiles.put(p);
      await setMeta(META_KEYS.AUTH_ROLE, p.role);
    }
  }, []);

  useEffect(() => {
    let mounted = true;

    void (async () => {
      const { data } = await supabase.auth.getSession();
      const uid = data.session?.user.id ?? null;
      if (!mounted) return;
      setUserId(uid);
      if (uid) {
        await setMeta(META_KEYS.AUTH_USER_ID, uid);
        await hydrateProfile(uid);
      }
      setLoading(false);
    })();

    const { data: sub } = supabase.auth.onAuthStateChange((_evt, session) => {
      const uid = session?.user.id ?? null;
      setUserId(uid);
      if (uid) {
        void setMeta(META_KEYS.AUTH_USER_ID, uid);
        void hydrateProfile(uid);
      } else {
        setProfile(null);
      }
    });

    return () => {
      mounted = false;
      sub.subscription.unsubscribe();
    };
  }, [hydrateProfile]);

  const signIn = useCallback(async (email: string, password: string) => {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    return { error: error?.message ?? null };
  }, []);

  const signOut = useCallback(async () => {
    await supabase.auth.signOut();
    setProfile(null);
    setUserId(null);
  }, []);

  const role = profile?.role ?? null;

  const value = useMemo<AuthContextValue>(() => ({
    loading,
    userId,
    profile,
    role,
    signIn,
    signOut,
    can: (perm: Permission) => can(role, perm),
    canAny: (perms: Permission[]) => canAny(role, perms),
  }), [loading, userId, profile, role, signIn, signOut]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
