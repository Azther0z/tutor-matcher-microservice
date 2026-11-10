"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { api, ApiError, sessionToken } from "./api";
import type { Account, AuthSession } from "./types";

type AuthState = { ready: boolean; account: Account | null; authError: string | null; refresh: () => Promise<Account | null>; accept: (session: AuthSession) => void; clearLocal: () => void; signOut: () => Promise<void> };
const Context = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [account, setAccount] = useState<Account | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const refresh = useCallback(async () => {
    if (!sessionToken.read()) { setAccount(null); setAuthError(null); return null; }
    try {
      const value = await api<Account>("/auth/me");
      setAccount(value);
      setAuthError(null);
      return value;
    } catch (error) {
      setAccount(null);
      if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
        sessionToken.clear();
        setAuthError(null);
      } else {
        setAuthError("We couldn’t verify your session. Your tab session is still saved. Check your connection and retry.");
      }
      return null;
    }
  }, []);
  useEffect(() => { void refresh().finally(() => setReady(true)); }, [refresh]);
  useEffect(() => {
    const handleExpiry = () => setAccount(null);
    window.addEventListener("tm:session-expired", handleExpiry);
    return () => window.removeEventListener("tm:session-expired", handleExpiry);
  }, []);
  const accept = useCallback((session: AuthSession) => {
    sessionToken.write(session.token);
    setAccount(session.user);
  }, []);
  const clearLocal = useCallback(() => { sessionToken.clear(); setAccount(null); }, []);
  const signOut = useCallback(async () => {
    try { if (sessionToken.read()) await api<void>("/auth/logout", { method: "POST", idempotencyKey: crypto.randomUUID() }); }
    catch { /* A failed logout must not keep a local token. */ }
    finally { clearLocal(); }
  }, [clearLocal]);
  const value = useMemo(() => ({ ready, account, authError, refresh, accept, clearLocal, signOut }), [ready, account, authError, refresh, accept, clearLocal, signOut]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useAuth(): AuthState {
  const value = useContext(Context);
  if (!value) throw new Error("useAuth must be used inside AuthProvider");
  return value;
}

export function RequireAuth({ children, admin = false }: { children: React.ReactNode; admin?: boolean }) {
  const { ready, account, authError, refresh } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  useEffect(() => {
    if (!ready) return;
    if (!account && !authError) router.replace(`/login?returnTo=${encodeURIComponent(pathname + window.location.search)}`);
  }, [ready, account, authError, router, pathname]);
  if (!ready) return <p className="muted" role="status">Checking your session…</p>;
  if (authError) return <section className="panel"><h1>We couldn’t check your session</h1><p role="alert">{authError}</p><button className="button" onClick={() => void refresh()}>Retry session check</button></section>;
  if (!account) return <p className="muted" role="status">Opening sign in…</p>;
  if (admin && !account.capabilities.includes("ADMIN")) return <section className="panel"><h1>Admin access required</h1><p>Your current account does not have the ADMIN capability.</p></section>;
  return <>{children}</>;
}
