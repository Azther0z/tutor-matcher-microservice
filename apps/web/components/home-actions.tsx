"use client";

import Link from "next/link";
import { useAuth } from "@/lib/auth-context";

export function HomeActions() {
  const { ready, account } = useAuth();
  const guest = ready && !account;
  return (
    <>
      <div className="actions">
        <Link className="button button-grey" href="/signup">Get started</Link>
        <Link className="button button-quiet" href="/teach/application">Become a tutor</Link>
        {guest && <Link className="text-link" href="/login">I already have an account</Link>}
      </div>
      {guest && <p className="hero-footnote">Every new account starts with student access.</p>}
    </>
  );
}
