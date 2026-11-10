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

function Balance({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return <div className="stat-line"><span className="tiny-label">{label}</span><strong>{value}</strong>{hint && <span className="small-muted">{hint}</span>}</div>;
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
      <header className="section-heading">
        <p className="eyebrow">WALLET</p>
        <h1>Your wallet</h1>
        <p>Posted funds, payout reservations and pending earnings are kept separate.</p>
      </header>
      <DemoBanner />
      {loading && <p role="status">Loading your wallet…</p>}
      <ErrorNotice failure={error} onRetry={() => void load()}/>
      {wallet && (
        <section className="panel" aria-label="Balances">
          <div className="account-grid">
            <Balance label="AVAILABLE" value={formatMoney(wallet.availableBalance)} hint="Spendable now" />
            <Balance label="POSTED" value={formatMoney(wallet.postedBalance)} hint="Completed movements" />
            <Balance label="RESERVED FOR PAYOUTS" value={formatMoney(wallet.reservedPayouts)} hint="Held until a payout resolves" />
            {isTutor && <Balance label="PENDING EARNINGS" value={formatMoney(wallet.pendingEarnings)} hint="Not spendable or payable yet" />}
            {isTutor && <Balance label="EARNED THIS MONTH" value={formatMoney(wallet.earningsThisMonth)} />}
            {isTutor && <Balance label="TOTAL PAID OUT" value={formatMoney(wallet.totalPaidOut)} />}
          </div>
          {wallet.paymentDueBookings.length > 0 && (
            <div>
              <h2>Bookings waiting for payment</h2>
              <ul>{wallet.paymentDueBookings.map((booking) => <li key={booking.id}><Link className="text-link" href={publicPath(booking.url)}>Booking {booking.id.slice(0, 8)}</Link></li>)}</ul>
            </div>
          )}
        </section>
      )}
      <TopupRequestPanel returnTo={returnTo} unavailable={Boolean(error) && !wallet} />
      <section className="panel" aria-labelledby="more-wallet-heading">
        <h2 id="more-wallet-heading">More from your wallet</h2>
        <div className="button-row">
          <Link className="button button-quiet" href="/wallet/transactions">Transaction history</Link>
          <Link className="button button-quiet" href="/disputes">Disputes</Link>
          {isTutor && <Link className="button button-quiet" href="/wallet/payout-accounts">Payout accounts</Link>}
          {isTutor && <Link className="button button-quiet" href="/wallet/payouts">Payouts</Link>}
          {isAdmin && <Link className="button button-quiet" href="/admin/disputes">Review disputes</Link>}
          {isAdmin && <Link className="button button-quiet" href="/demo/finance">Demo provider controls</Link>}
        </div>
      </section>
    </>
  );
}
