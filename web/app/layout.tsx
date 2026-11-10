import type { Metadata } from "next";
import Link from "next/link";
import { AuthProvider } from "@/lib/auth-context";
import { SignOutButton } from "@/components/sign-out";
import "./globals.css";

export const metadata: Metadata = { title: "Tutor Matcher", description: "Find the right tutor for your next learning goal." };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body><AuthProvider><header className="site-header"><Link className="brand" href="/" aria-label="Tutor Matcher home"><span className="brand-mark">T</span><span>Tutor Matcher</span></Link><nav aria-label="Main navigation"><Link href="/login">Log in</Link><Link className="nav-cta" href="/signup">Create account</Link><Link href="/account">Account</Link><Link href="/wallet">Wallet</Link><Link href="/notifications">Notifications</Link><Link href="/admin/users">Admin</Link></nav><SignOutButton /></header><main className="page-shell">{children}</main><footer className="site-footer"><span>Learn with confidence.</span><span>Your learning, your pace.</span></footer></AuthProvider></body></html>
}
