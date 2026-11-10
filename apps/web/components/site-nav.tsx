"use client";

import Link from "next/link";
import { useAuth } from "@/lib/auth-context";
import { SignOutButton } from "./sign-out";

/** Header navigation driven by who is signed in and what they may do. */
export function SiteNav() {
  const { ready, account } = useAuth();
  const isAdmin = account?.capabilities.includes("ADMIN") ?? false;
  return (
    <nav aria-label="Main navigation">
      <Link href="/discover">Find tutors</Link>
      {ready && !account && <><Link href="/login">Log in</Link><Link className="nav-cta" href="/signup">Create account</Link></>}
      {account && <><Link href="/account">Account</Link><Link href="/wallet">Wallet</Link><Link href="/notifications">Notifications</Link>{isAdmin && <Link href="/admin/users">Admin</Link>}<SignOutButton /></>}
    </nav>
  );
}
