"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";

const LINKS = [
  { label: "Home", href: "/" },
  { label: "Find tutors", href: "/discover" },
  { label: "Bookings", href: "/bookings" },
  { label: "Messages", href: "/messages" },
];

const ADMIN_LINKS = [
  { label: "Accounts", href: "/admin/users" },
  { label: "Tutor requests", href: "/admin/tutor-requests" },
  { label: "Top-up requests", href: "/admin/topups" },
  { label: "Disputes", href: "/admin/disputes" },
  { label: "Review reports", href: "/admin/review-flags" },
  { label: "Password resets", href: "/demo/password-resets" },
  { label: "Provider controls", href: "/demo/finance" },
];

const baht = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Header navigation: page links and a "Become a tutor" pill, then wallet balance and account menu (or Login / Sign-up). */
export function SiteNav() {
  const pathname = usePathname();
  const router = useRouter();
  const { ready, account, signOut } = useAuth();
  const [open, setOpen] = useState<null | "account" | "admin">(null);
  const menuOpen = open === "account";
  const setMenuOpen = (value: boolean | ((current: boolean) => boolean)) => {
    const next = typeof value === "function" ? value(open === "account") : value;
    setOpen(next ? "account" : null);
  };
  const [balance, setBalance] = useState<string | null>(null);
  const [unread, setUnread] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const isAdmin = account?.capabilities.includes("ADMIN") ?? false;
  const isTutor = account?.capabilities.includes("TUTOR") ?? false;

  const [walletTick, setWalletTick] = useState(0);
  useEffect(() => {
    const refresh = () => setWalletTick((tick) => tick + 1);
    window.addEventListener("wallet:changed", refresh);
    window.addEventListener("focus", refresh);
    return () => { window.removeEventListener("wallet:changed", refresh); window.removeEventListener("focus", refresh); };
  }, []);

  useEffect(() => {
    if (!account) return;
    let cancelled = false;
    api<{ availableBalance: { amount: string } }>("/wallet")
      .then((wallet) => { if (!cancelled) setBalance(wallet.availableBalance.amount); })
      .catch(() => { if (!cancelled) setBalance(null); });
    api<{ items: Array<{ unreadCount: number }> }>("/messages/inbox?pageSize=100")
      .then((inbox) => { if (!cancelled) setUnread(inbox.items.some((item) => item.unreadCount > 0)); })
      .catch(() => { if (!cancelled) setUnread(false); });
    return () => { cancelled = true; };
  }, [account, pathname, walletTick]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!menuRef.current?.contains(event.target as Node)) setOpen(null); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(null); };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); };
  }, [open]);
  useEffect(() => { setOpen(null); }, [pathname]);

  const active = (href: string) => (href === "/" ? pathname === "/" : pathname.startsWith(href));
  const name = account ? (account.lastName ? `${account.firstName} ${account.lastName.charAt(0)}.` : account.firstName) : "";
  async function logout() {
    setMenuOpen(false);
    await signOut();
    router.push("/");
  }

  return (
    <nav className="site-nav" aria-label="Main navigation">
      <div className="nav-group">
        {LINKS.map((link) => (
          <Link key={link.href} href={link.href} className={`nav-link ${active(link.href) ? "active" : ""}`} aria-current={active(link.href) ? "page" : undefined}>
            {link.label}
            {link.href === "/messages" && account && unread && <span className="unread-dot" aria-label="New messages" />}
          </Link>
        ))}
        {!isTutor && !isAdmin && <Link href="/teach/application" className="nav-pill">Become a tutor</Link>}
        {isTutor && <Link href="/teach/lessons" className={`nav-link ${active("/teach") ? "active" : ""}`}>Teach</Link>}
      </div>
      <div className="nav-group">
        {ready && account ? (
          <div className="account-menu-wrap" ref={menuRef}>
            {isAdmin && (
              <span className="menu-anchor">
                <button type="button" className="admin-button" aria-expanded={open === "admin"} aria-haspopup="menu" onClick={() => setOpen(open === "admin" ? null : "admin")}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M12 3 4.5 6v5.5c0 4.5 3.1 8.2 7.5 9.5 4.4-1.3 7.5-5 7.5-9.5V6L12 3Z" /><path d="m9 12 2.2 2.2L15.5 10" />
                  </svg>
                  Admin
                  <svg className="admin-chevron" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m3 4.5 3 3 3-3" /></svg>
                </button>
                {open === "admin" && (
                  <div className="account-menu admin-menu" role="menu">
                    {ADMIN_LINKS.map((link) => (
                      <Link key={link.href} href={link.href} role="menuitem" className={pathname.startsWith(link.href) ? "current" : undefined}>{link.label}</Link>
                    ))}
                  </div>
                )}
              </span>
            )}
            <Link href="/wallet" className="nav-link wallet-chip" aria-label="Wallet balance" title="Open your wallet" onClick={() => setOpen(null)}>
              {balance === null ? "฿ —" : `฿ ${baht.format(Number(balance))}`}
            </Link>
            <span className="menu-anchor">
              <button type="button" className="avatar-button" aria-label="Open account menu" aria-expanded={menuOpen} onClick={() => setOpen(menuOpen ? null : "account")}>
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <circle cx="12" cy="12" r="9.5" /><circle cx="12" cy="10" r="3" /><path d="M6.2 18.4c1.3-2.3 3.4-3.4 5.8-3.4s4.5 1.1 5.8 3.4" />
                </svg>
              </button>
              {menuOpen && (
                <div className="account-menu" role="menu">
                  <div className="account-menu-head">
                    <strong>{name}</strong>
                    <span>{account.email}</span>
                  </div>
                  <Link href="/account" role="menuitem">Settings</Link>
                  <Link href="/notifications" role="menuitem">Notifications</Link>
                  <hr />
                  <button type="button" role="menuitem" onClick={() => void logout()}>Log out</button>
                </div>
              )}
            </span>
          </div>
        ) : ready ? (
          <>
            <Link href="/login" className={`nav-link ${pathname.startsWith("/login") ? "active" : ""}`}>Login</Link>
            <Link href="/signup" className={`nav-link ${pathname.startsWith("/signup") ? "active" : ""}`}>Sign-up</Link>
          </>
        ) : null}
      </div>
    </nav>
  );
}
