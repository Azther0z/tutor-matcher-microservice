import type { Metadata } from "next";

export const metadata: Metadata = { title: "Terms of Service" };

export default function TermsPage() {
  return <><header className="section-heading"><p className="eyebrow">LEGAL</p><h1>Terms of Service</h1><p>These terms describe the Tutor Matcher course demonstration.</p></header><section className="panel legal-copy"><h2>Using Tutor Matcher</h2><p>Use accurate account information, keep your credentials private, and use lessons, messages, reviews, and disputes only for their intended learning purpose.</p><h2>Demonstration environment</h2><p>This deployment simulates payments, notifications, and provider integrations. Do not enter real banking credentials or sensitive identity documents unless your course administrator explicitly provides a protected test environment.</p><h2>Account and content</h2><p>You remain responsible for content you submit. Access may be limited when an account is deactivated or violates the rules of the demonstration.</p><p className="muted">Last updated 10 November 2026.</p></section></>;
}
