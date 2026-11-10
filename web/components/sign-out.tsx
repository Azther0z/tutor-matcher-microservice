"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useAuth } from "@/lib/auth-context";

export function SignOutButton() {
  const { account, signOut } = useAuth();
  const [pending, setPending] = useState(false);
  const router = useRouter();
  async function handleSignOut() {
    setPending(true);
    try { await signOut(); } finally { router.replace("/login"); setPending(false); }
  }
  if (!account) return null;
  return <button className="button button-quiet" onClick={() => void handleSignOut()} disabled={pending}>{pending ? "Signing out…" : "Sign out"}</button>;
}
