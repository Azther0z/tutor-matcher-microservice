"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";
import { useAuth } from "@/lib/auth-context";
import { SignOutButton } from "./sign-out";

const exactTitles: Record<string, string> = {
  "/": "Tutor Matcher",
  "/login": "Log in | Tutor Matcher",
  "/signup": "Create account | Tutor Matcher",
  "/password-reset": "Reset password | Tutor Matcher",
  "/discover": "Find tutors | Tutor Matcher",
  "/account": "Account | Tutor Matcher",
  "/bookings": "Bookings | Tutor Matcher",
  "/messages": "Messages | Tutor Matcher",
  "/notifications": "Notifications | Tutor Matcher",
  "/wallet": "Wallet | Tutor Matcher",
  "/disputes": "Disputes | Tutor Matcher",
  "/reviews": "Reviews | Tutor Matcher",
  "/terms": "Terms of Service | Tutor Matcher",
  "/privacy": "Privacy notice | Tutor Matcher",
  "/support": "Support | Tutor Matcher",
  "/teach/application": "Tutor application | Tutor Matcher",
  "/teach/profile": "Tutor profile | Tutor Matcher",
  "/teach/subjects": "Tutor subjects | Tutor Matcher",
  "/teach/availability": "Tutor availability | Tutor Matcher",
};

function titleFor(pathname: string): string {
  if (exactTitles[pathname]) return exactTitles[pathname];
  if (/^\/bookings\/.+/.test(pathname)) return "Booking | Tutor Matcher";
  if (/^\/messages\/.+/.test(pathname)) return "Conversation | Tutor Matcher";
  if (/^\/tutors\/.+\/subjects\/.+/.test(pathname))
    return "Subject availability | Tutor Matcher";
  if (/^\/tutors\/.+/.test(pathname)) return "Tutor profile | Tutor Matcher";
  if (/^\/wallet\/transactions\/.+/.test(pathname))
    return "Transaction | Tutor Matcher";
  if (pathname.startsWith("/wallet/transactions"))
    return "Transaction history | Tutor Matcher";
  if (pathname.startsWith("/wallet/payout"))
    return "Tutor payouts | Tutor Matcher";
  if (/^\/disputes\/.+/.test(pathname)) return "Dispute | Tutor Matcher";
  if (pathname.startsWith("/admin")) return "Admin | Tutor Matcher";
  return "Page not found | Tutor Matcher";
}

function PageTitle() {
  const pathname = usePathname();
  useEffect(() => {
    document.title = titleFor(pathname);
  }, [pathname]);
  return null;
}

function SiteHeader() {
  const { ready, account } = useAuth();
  const pathname = usePathname();
  const menu = useRef<HTMLDetailsElement>(null);
  useEffect(() => { if (menu.current) menu.current.open = false; }, [pathname]);
  const isTutor = account?.capabilities.includes("TUTOR");
  const isAdmin = account?.capabilities.includes("ADMIN");
  return (
    <header className="site-header">
      <Link className="brand" href="/" aria-label="Tutor Matcher home">
        <span className="brand-mark">T</span>
        <span>Tutor Matcher</span>
      </Link>
      <details className="site-menu" ref={menu}>
        <summary>Menu</summary>
        <nav aria-label="Main navigation">
          <Link href="/discover">Find tutors</Link>
          {!ready && (
            <span className="nav-loading" role="status">
              Loading account…
            </span>
          )}
          {ready && !account && <Link href="/login">Log in</Link>}
          {ready && !account && (
            <Link className="nav-cta" href="/signup">
              Create account
            </Link>
          )}
          {account && <Link href="/bookings">Bookings</Link>}
          {account && <Link href="/messages">Messages</Link>}
          {account && <Link href="/wallet">Wallet</Link>}
          {account && <Link href="/notifications">Notifications</Link>}
          {account && (
            <Link href={isTutor ? "/teach/profile" : "/teach/application"}>
              {isTutor ? "Teach" : "Become a tutor"}
            </Link>
          )}
          {account && <Link href="/account">Account</Link>}
          {isAdmin && <Link href="/admin/users">Admin</Link>}
          {account && <SignOutButton />}
        </nav>
      </details>
    </header>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <>
      <PageTitle />
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <SiteHeader />
      <main id="main-content" className="page-shell" tabIndex={-1}>
        {children}
      </main>
      <footer className="site-footer">
        <span>Learn with confidence.</span>
        <nav aria-label="Footer navigation">
          <Link href="/terms">Terms</Link>
          <Link href="/privacy">Privacy</Link>
          <Link href="/support">Support</Link>
        </nav>
      </footer>
    </>
  );
}
