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

const MANUAL_TEXT: Record<Topup["status"], string> = {
  PENDING: "Your slip is with an admin for review. Your balance is credited when it is approved.",
  SUCCEEDED: "An admin approved your top-up. Your balance was credited once.",
  FAILED: "An admin rejected this top-up. Nothing was credited.",
  UNKNOWN: "This request needs another look. Nothing is credited until it is approved.",
};
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

  const label = topup
    ? topup.manual
      ? topup.status === "SUCCEEDED" ? "APPROVED" : topup.status === "FAILED" ? "REJECTED" : "PENDING"
      : topup.status
    : "";
  return (
    <>
      <header className="page-heading"><h1>Top-up</h1></header>
      {topup && !topup.manual && <DemoBanner />}
      <LoadError failure={error} onRetry={() => void load()} backHref="/wallet" backLabel="Back to wallet"/>
      {!topup && !error && <p role="status" className="tutor-card-meta">Loading…</p>}
      {topup && (
        <section className="panel booking-new">
          <StatusBadge value={label} corner />
          <div className="booking-title">
            <h2>{formatMoney(topup.amount)}</h2>
            <p className="tutor-card-meta" role="status">{(topup.manual ? MANUAL_TEXT : OUTCOME_TEXT)[topup.status]}</p>
          </div>
          {operation?.error && <p className="tutor-card-meta">{operation.error}</p>}
          {operation?.status === "TIMEOUT" && <Notice kind="info">Still waiting. You can leave this page; the result will appear in your wallet.</Notice>}
          <div className="summary-rows">
            <div>
              <span>Sent</span>
              <strong>{formatTime(topup.createdAt)}</strong>
            </div>
            {topup.confirmedAt && (
              <div>
                <span>Confirmed</span>
                <strong>{formatTime(topup.confirmedAt)}</strong>
              </div>
            )}
            {topup.manual && topup.decisionReason && (
              <div>
                <span>Admin note</span>
                <strong className="summary-note">{topup.decisionReason}</strong>
              </div>
            )}
            {!topup.manual && (
              <div>
                <span>Simulated payment code</span>
                <code className="summary-note">{topup.paymentRepresentation}</code>
              </div>
            )}
          </div>
          {!topup.manual && <p className="tutor-card-meta"><strong>Not payable.</strong> This is a demonstration code. Do not scan it with a banking app.</p>}
          <div className="slot-footer flush">
            <span className="button-row">
              <Link className="button button-quiet" href="/wallet">Go to wallet</Link>
              {topup.status !== "SUCCEEDED" && returnTo && <Link className="button button-quiet" href={`/bookings/${returnTo}`}>Back to booking without paying</Link>}
            </span>
            <span className="button-row">
              {topup.status === "SUCCEEDED" && returnTo && <Link className="button" href={`/bookings/${returnTo}`}>Return to your booking</Link>}
            </span>
          </div>
        </section>
      )}
    </>
  );
}
