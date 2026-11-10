import type { Metadata } from "next";

export const metadata: Metadata = { title: "Privacy notice" };

export default function PrivacyPage() {
  return <><header className="section-heading"><p className="eyebrow">LEGAL</p><h1>Privacy notice</h1><p>What this course demonstration stores and why.</p></header><section className="panel legal-copy"><h2>Information used</h2><p>Tutor Matcher stores account details, learning preferences, tutor submissions, bookings, messages, reviews, wallet demonstration records, and security audit information needed to provide the service.</p><h2>How it is used</h2><p>Information is used to match learners and tutors, operate the selected flows, protect accounts, and diagnose requests. Error references help administrators find the matching service log without exposing internal details.</p><h2>Your choices</h2><p>You can update your profile, notification preferences, and account status from the app. Deactivation revokes access while preserving records that are needed for bookings, funds, and audit history.</p><p className="muted">Last updated 10 November 2026.</p></section></>;
}
