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

const baht = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Header navigation: page links and a "Become a tutor" pill, then wallet balance and account menu (or Login / Sign-up). */
export function SiteNav() {
  const pathname = usePathname();
  const router = useRouter();
  const { ready, account, signOut } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);
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
    if (!menuOpen) return;
    const outside = (event: PointerEvent) => { if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setMenuOpen(false); };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); };
  }, [menuOpen]);

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
            <Link href="/wallet" className="nav-link wallet-chip" aria-label="Wallet balance" title="Open your wallet" onClick={() => setMenuOpen(false)}>
              {balance === null ? "฿ —" : `฿ ${baht.format(Number(balance))}`}
            </Link>
            <button type="button" className="avatar-button" aria-label="Open account menu" aria-expanded={menuOpen} onClick={() => setMenuOpen((open) => !open)}>
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="9.5" /><circle cx="12" cy="10" r="3" /><path d="M6.2 18.4c1.3-2.3 3.4-3.4 5.8-3.4s4.5 1.1 5.8 3.4" />
              </svg>
            </button>
            {menuOpen && (
              <div className="account-menu">
                <p>Signed in as <strong>{name}</strong></p>
                <Link href="/account" onClick={() => setMenuOpen(false)}>Settings</Link>
                <Link href="/notifications" onClick={() => setMenuOpen(false)}>Notifications</Link>
                {isAdmin && <Link href="/admin/tutor-requests" onClick={() => setMenuOpen(false)}>Tutor requests</Link>}
                {isAdmin && <Link href="/admin/topups" onClick={() => setMenuOpen(false)}>Top-up requests</Link>}
                {isAdmin && <Link href="/admin/users" onClick={() => setMenuOpen(false)}>Admin</Link>}
                <hr />
                <button type="button" onClick={() => void logout()}>Logout</button>
              </div>
            )}
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
