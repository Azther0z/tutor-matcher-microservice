import type { Metadata } from "next";
import { IBM_Plex_Sans_Thai, Rubik } from "next/font/google";
import Link from "next/link";
import { AuthProvider } from "@/lib/auth-context";
import { SiteNav } from "@/components/site-nav";
import "./globals.css";

const rubik = Rubik({ subsets: ["latin"], display: "swap", variable: "--font-rubik" });
const plexThai = IBM_Plex_Sans_Thai({ subsets: ["thai", "latin"], weight: ["400", "500", "600", "700"], display: "swap", variable: "--font-plex-thai" });

export const metadata: Metadata = { title: { default: "Tutor Matcher", template: "%s · Tutor Matcher" }, description: "Find the right tutor for your next learning goal." };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en" className={`${rubik.variable} ${plexThai.variable}`}><body><AuthProvider><a className="skip-link" href="#main">Skip to main content</a><header className="site-header"><Link className="brand" href="/" aria-label="Tutor Matcher home"><span className="brand-mark">T</span><span>Tutor Matcher</span></Link><SiteNav /></header><main className="page-shell" id="main" tabIndex={-1}>{children}</main><footer className="site-footer"><span>Learn with confidence.</span><span>Your learning, your pace.</span></footer></AuthProvider></body></html>
}
