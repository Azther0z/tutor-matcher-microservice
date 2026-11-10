"use client";

import Link from "next/link";
import { use, useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { LoadError, Notice } from "@/components/field";
import { api, failureOf, type Failure } from "@/lib/api";
import { DemoBanner, StatusBadge, useOperation } from "./common";
import { formatMoney, formatTime } from "./format";
import { returnBookingId } from "./overview";
import type { Topup } from "./types";

const OUTCOME_TEXT: Record<Topup["status"], string> = {
  PENDING: "Waiting for the demonstration provider. Nothing has been credited yet.",
  SUCCEEDED: "The demonstration provider reported success. Your balance was credited once.",
  FAILED: "The demonstration provider reported failure. Nothing was credited.",
  UNKNOWN: "The outcome is unknown. Nothing is credited unless the provider later reports success.",
};

export function TopupPage({ params }: { params: Promise<{ topupId: string }> }) {
  const { topupId } = use(params);
  const returnTo = returnBookingId(useSearchParams());
  const [topup, setTopup] = useState<Topup | null>(null);
  const [error, setError] = useState<Failure | null>(null);

  const load = useCallback(async () => {
    try { setTopup(await api<Topup>(`/wallet/topups/${topupId}`)); setError(null); }
    catch (e) { setError(failureOf(e, "We couldn’t load this top-up.")); }
  }, [topupId]);
  useEffect(() => { void load(); }, [load]);
  const operation = useOperation(topup?.operation, () => void load());

  return (
    <>
      <header className="section-heading"><p className="eyebrow">WALLET</p><h1>Top-up</h1><p><Link className="text-link" href="/wallet">Back to wallet</Link></p></header>
      <DemoBanner />
      <LoadError failure={error} onRetry={() => void load()} backHref="/wallet" backLabel="Back to wallet"/>
      {!topup && !error && <p role="status">Loading…</p>}
      {topup && (
        <section className="panel">
          <div className="stat-line"><span className="tiny-label">AMOUNT</span><strong>{formatMoney(topup.amount)}</strong></div>
          <p>Status: <StatusBadge value={topup.status} /></p>
          <p role="status">{OUTCOME_TEXT[topup.status]}</p>
          {operation?.error && <p className="small-muted">{operation.error}</p>}
          {operation?.status === "TIMEOUT" && <Notice kind="info">Still waiting. You can leave this page; the result will appear in your wallet.</Notice>}
          <h2>Simulated payment code</h2>
          <div className="sensitive-box" aria-label="Simulated payment code">
            <p><strong>Not payable.</strong> This is a demonstration code. Do not scan it with a banking app.</p>
            <code>{topup.paymentRepresentation}</code>
          </div>
          <p className="small-muted">Created {formatTime(topup.createdAt)}{topup.confirmedAt ? ` · Confirmed ${formatTime(topup.confirmedAt)}` : ""}</p>
          <div className="button-row">
            {topup.status === "SUCCEEDED" && returnTo && <Link className="button" href={`/bookings/${returnTo}`}>Return to your booking</Link>}
            {topup.status !== "SUCCEEDED" && returnTo && <Link className="button button-quiet" href={`/bookings/${returnTo}`}>Back to booking without paying</Link>}
            <Link className="button button-quiet" href="/wallet">Go to wallet</Link>
          </div>
        </section>
      )}
    </>
  );
}
