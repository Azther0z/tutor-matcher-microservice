import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = { title: "Support" };

export default function SupportPage() {
  return <><header className="section-heading"><p className="eyebrow">HELP</p><h1>Support</h1><p>Get help with an account or a failed request.</p></header><section className="panel"><h2>Course demonstration support</h2><p>Contact the team or course administrator who gave you access to this deployment. Include what you were trying to do, the time it happened, and the error reference shown in the app.</p><p>For lesson-specific help, open the relevant <Link className="text-link" href="/bookings">booking</Link>. For account access, share only your email address—never your password or reset token.</p><div className="button-row"><Link className="button" href="/account">Open account settings</Link><Link className="button button-quiet" href="/discover">Find a tutor</Link></div></section></>;
}
