"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { ErrorNotice } from "@/components/field";
import { useAuth } from "@/lib/auth-context";
import { api, failureOf, type Failure } from "@/lib/api";
import { DemoBanner } from "./common";
import { TopupRequestPanel } from "./topup-request";
import { formatMoney, formatTime, titleCase } from "./format";
import type { Paged, WalletOverview, WalletTransaction } from "./types";

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
  const [waiting, setWaiting] = useState(false);
  const [topupOpen, setTopupOpen] = useState(Boolean(returnTo));
  const [recent, setRecent] = useState<WalletTransaction[]>([]);
  const isTutor = account?.capabilities.includes("TUTOR") ?? false;
  const isAdmin = account?.capabilities.includes("ADMIN") ?? false;

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try { setWallet(await api<WalletOverview>("/wallet")); }
    catch (e) { setError(failureOf(e, "We couldn’t load your wallet.")); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    api<Paged<WalletTransaction>>("/wallet/transactions?page=1&pageSize=6").then((page) => setRecent(page.items)).catch(() => setRecent([]));
  }, []);

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
          <div className="wallet-available-row">
            <div className="wallet-available">
              <span>Available balance</span>
              <strong>{formatMoney(wallet.availableBalance)}</strong>
            </div>
            <span className={waiting ? "tooltip-wrap tip-right" : undefined} data-tip={waiting ? "A top-up request is waiting for review" : undefined}>
              <button type="button" className="button" onClick={() => setTopupOpen(true)} disabled={waiting || (Boolean(error) && !wallet)}><span aria-hidden="true">+</span> Top up</button>
            </span>
          </div>
          <div className="summary-rows">
            <Row label="Posted" value={formatMoney(wallet.postedBalance)} hint="Completed movements" />
            <Row label="Reserved for payouts" value={formatMoney(wallet.reservedPayouts)} hint="Held until a payout resolves" />
            {isTutor && <Row label="Pending earnings" value={formatMoney(wallet.pendingEarnings)} hint="Not spendable or payable yet" />}
            {isTutor && <Row label="Earned this month" value={formatMoney(wallet.earningsThisMonth)} />}
            {isTutor && <Row label="Total paid out" value={formatMoney(wallet.totalPaidOut)} />}
          </div>
        </section>
      )}
      <TopupRequestPanel returnTo={returnTo} unavailable={Boolean(error) && !wallet} open={topupOpen} onClose={() => setTopupOpen(false)} onWaiting={setWaiting} />
      <section className="panel wallet-recent" aria-label="Recent activity">
        <div className="wallet-recent-head">
          <h2>Recent activity</h2>
          <Link className="wallet-viewall" href="/wallet/transactions">View all</Link>
        </div>
        {recent.length === 0 ? (
          <p className="tutor-card-meta">No transactions yet.</p>
        ) : (
          recent.map((tx) => (
            <Link key={tx.id} className="wallet-tx" href={`/wallet/transactions/${tx.id}`}>
              <span>
                {titleCase(tx.type)}
                <small>{formatTime(tx.createdAt)}</small>
              </span>
              <strong className={tx.direction === "IN" ? "status-good" : ""}>
                {tx.direction === "IN" ? "+" : "-"}{formatMoney(tx.amount)}
              </strong>
            </Link>
          ))
        )}
      </section>
    </>
  );
}
