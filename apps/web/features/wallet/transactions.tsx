"use client";

import Link from "next/link";
import { use, useCallback, useEffect, useState } from "react";
import { LoadError } from "@/components/field";
import { Dropdown } from "@/components/dropdown";
import { api, failureOf, type Failure } from "@/lib/api";
import { Pager, StatusBadge } from "./common";
import { formatMoney, formatTime, titleCase } from "./format";
import { TRANSACTION_TYPES, type Paged, type WalletTransaction } from "./types";

export function TransactionsPage() {
  const [type, setType] = useState("");
  const [result, setResult] = useState<Paged<WalletTransaction> | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<Failure | null>(null);

  const load = useCallback(async (page: number) => {
    setPending(true); setError(null);
    const params = new URLSearchParams({ page: String(page), pageSize: "20" });
    if (type) params.set("type", type);
    try { setResult(await api<Paged<WalletTransaction>>(`/wallet/transactions?${params}`)); }
    catch (e) { setError(failureOf(e, "We couldn’t load your transactions.")); }
    finally { setPending(false); }
  }, [type]);
  useEffect(() => { void load(1); }, [load]);

  return (
    <>
      <header className="page-heading page-heading-row">
        <h1>Transactions</h1>
        <div className="tx-filter">
          <Dropdown id="type" value={type} onValueChange={setType} options={[
            { value: "", label: "All types" },
            ...TRANSACTION_TYPES.map((value) => ({ value, label: titleCase(value) })),
          ]} />
        </div>
      </header>
      <LoadError failure={error} onRetry={() => void load(1)} backHref="/wallet" backLabel="Back to wallet"/>
      {pending && !result && <p role="status" className="tutor-card-meta">Loading transactions…</p>}
      {result && result.items.length === 0 && <p className="tutor-card-meta">No transactions yet.</p>}
      {result && result.items.length > 0 && (
        <div className="tx-list" aria-label="Transactions">
          {result.items.map((tx) => (
            <Link key={tx.id} className="panel tutor-card tx-card" href={`/wallet/transactions/${tx.id}`}>
              <span>
                <strong>{titleCase(tx.type)}</strong>
                <small>{formatTime(tx.createdAt)}</small>
              </span>
              <span className="wallet-tx-amount">
                <strong className={tx.direction === "IN" ? "status-good" : ""}>
                  {tx.direction === "IN" ? "+" : "-"}{formatMoney(tx.amount)}
                </strong>
                <small>Balance {formatMoney(tx.balanceAfter)}</small>
              </span>
            </Link>
          ))}
        </div>
      )}
      {result && <Pager meta={result.pagination} onPage={(page) => void load(page)} disabled={pending} />}
    </>
  );
}

export function TransactionDetailPage({ params }: { params: Promise<{ transactionId: string }> }) {
  const { transactionId } = use(params);
  const [tx, setTx] = useState<WalletTransaction | null>(null);
  const [error, setError] = useState<Failure | null>(null);
  const load = useCallback(() => {
    setError(null);
    api<WalletTransaction>(`/wallet/transactions/${transactionId}`).then(setTx).catch((e) => setError(failureOf(e, "We couldn’t load this transaction.")));
  }, [transactionId]);
  useEffect(() => { load(); }, [load]);
  return (
    <>
      <header className="page-heading"><h1>Transaction</h1></header>
      <LoadError failure={error} onRetry={load} backHref="/wallet/transactions" backLabel="Back to transactions"/>
      {!tx && !error && <p role="status" className="tutor-card-meta">Loading…</p>}
      {tx && (
        <section className="panel booking-new">
          <StatusBadge value={tx.direction} corner />
          <div className="booking-title">
            <h2>{titleCase(tx.type)}</h2>
            <p className="tutor-card-meta">{formatTime(tx.createdAt)}</p>
          </div>
          <div className="summary-rows">
            <div>
              <span>Amount</span>
              <strong className={tx.direction === "IN" ? "status-good" : ""}>{tx.direction === "IN" ? "+" : "-"}{formatMoney(tx.amount)}</strong>
            </div>
            <div>
              <span>Balance after</span>
              <strong>{formatMoney(tx.balanceAfter)}</strong>
            </div>
            {tx.bookingId && (
              <div>
                <span>Booking</span>
                <Link className="summary-link" href={`/bookings/${tx.bookingId}`}>View booking</Link>
              </div>
            )}
            <div>
              <span>Reference</span>
              <code className="summary-note">{tx.operationId}</code>
            </div>
          </div>
        </section>
      )}
    </>
  );
}
