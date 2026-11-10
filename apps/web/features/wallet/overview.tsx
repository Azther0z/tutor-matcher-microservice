"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { ErrorNotice } from "@/components/field";
import { useAuth } from "@/lib/auth-context";
import { api, failureOf, type Failure } from "@/lib/api";
import { DemoBanner } from "./common";
import { TopupRequestPanel } from "./topup-request";
import { formatMoney, publicPath } from "./format";
import type { WalletOverview } from "./types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** The booking a student was sent here from, if any. Only a well-formed id is ever kept. */
export function returnBookingId(params: URLSearchParams): string | null {
  const value = params.get("returnToBookingId") ?? params.get("bookingId");
  return value && UUID.test(value) ? value : null;
}

function Row({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div title={hint}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

export function WalletOverviewPage() {
  const { account } = useAuth();
  const params = useSearchParams();
  const returnTo = returnBookingId(params);
  const [wallet, setWallet] = useState<WalletOverview | null>(null);
  const [error, setError] = useState<Failure | null>(null);
  const [loading, setLoading] = useState(true);
  const isTutor = account?.capabilities.includes("TUTOR") ?? false;
  const isAdmin = account?.capabilities.includes("ADMIN") ?? false;

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try { setWallet(await api<WalletOverview>("/wallet")); }
    catch (e) { setError(failureOf(e, "We couldn’t load your wallet.")); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  return (
    <>
      <header className="page-heading page-heading-row">
        <h1>Wallet</h1>
        <nav className="wallet-links" aria-label="Wallet pages">
          <Link href="/wallet/transactions">Transactions</Link>
          <Link href="/disputes">Disputes</Link>
          {isTutor && <Link href="/wallet/payout-accounts">Payout accounts</Link>}
          {isTutor && <Link href="/wallet/payouts">Payouts</Link>}
          {isAdmin && <Link href="/admin/disputes">Review disputes</Link>}
          {isAdmin && <Link href="/demo/finance">Demo provider controls</Link>}
        </nav>
      </header>
      <DemoBanner />
      {loading && <p role="status" className="tutor-card-meta">Loading your wallet…</p>}
      <ErrorNotice failure={error} onRetry={() => void load()}/>
      {wallet && (
        <section className="panel wallet-balance" aria-label="Balances">
          <div className="wallet-available">
            <span>Available balance</span>
            <strong>{formatMoney(wallet.availableBalance)}</strong>
          </div>
          <div className="summary-rows">
            <Row label="Posted" value={formatMoney(wallet.postedBalance)} hint="Completed movements" />
            <Row label="Reserved for payouts" value={formatMoney(wallet.reservedPayouts)} hint="Held until a payout resolves" />
            {isTutor && <Row label="Pending earnings" value={formatMoney(wallet.pendingEarnings)} hint="Not spendable or payable yet" />}
            {isTutor && <Row label="Earned this month" value={formatMoney(wallet.earningsThisMonth)} />}
            {isTutor && <Row label="Total paid out" value={formatMoney(wallet.totalPaidOut)} />}
          </div>
          {wallet.paymentDueBookings.length > 0 && (
            <div className="wallet-due">
              <h2>Waiting for payment</h2>
              {wallet.paymentDueBookings.map((booking) => (
                <Link key={booking.id} href={publicPath(booking.url)}>
                  <span>Booking {booking.id.slice(0, 8)}</span>
                  <span className="status-text status-due">Payment due</span>
                </Link>
              ))}
            </div>
          )}
        </section>
      )}
      <TopupRequestPanel returnTo={returnTo} unavailable={Boolean(error) && !wallet} />
    </>
  );
}
