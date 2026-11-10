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
      <header className="section-heading">
        <h1>Transaction history</h1>
        <p>Only completed movements appear here. Reservations and pending earnings are on your <Link className="text-link" href="/wallet">wallet</Link> page.</p>
      </header>
      <section className="panel">
        <div className="field">
          <label htmlFor="type">Type</label>
          <Dropdown id="type" value={type} onValueChange={setType} options={[
            { value: "", label: "All types" },
            ...TRANSACTION_TYPES.map((value) => ({ value, label: titleCase(value) })),
          ]} />
        </div>
        <LoadError failure={error} onRetry={() => void load(1)} backHref="/wallet" backLabel="Back to wallet"/>
        {pending && !result && <p role="status">Loading transactions…</p>}
        {result && result.items.length === 0 && <p className="empty-state">No transactions yet.</p>}
        {result && result.items.length > 0 && (
          <div className="table-wrap">
            <table className="data-table">
              <caption className="muted">{result.pagination.totalItems} transaction(s)</caption>
              <thead><tr><th>When</th><th>Type</th><th>Amount</th><th>Balance after</th><th><span className="muted">Details</span></th></tr></thead>
              <tbody>
                {result.items.map((tx) => (
                  <tr key={tx.id}>
                    <td>{formatTime(tx.createdAt)}</td>
                    <td>{titleCase(tx.type)}</td>
                    <td><StatusBadge value={tx.direction} /> {formatMoney(tx.amount)}</td>
                    <td>{formatMoney(tx.balanceAfter)}</td>
                    <td><Link className="text-link" href={`/wallet/transactions/${tx.id}`}>View</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {result && <Pager meta={result.pagination} onPage={(page) => void load(page)} disabled={pending} />}
      </section>
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
      <header className="section-heading"><h1>Transaction</h1><p><Link className="text-link" href="/wallet/transactions">Back to history</Link></p></header>
      <section className="panel">
        <LoadError failure={error} onRetry={load} backHref="/wallet/transactions" backLabel="Back to history"/>
        {!tx && !error && <p role="status">Loading…</p>}
        {tx && (
          <dl className="audit-list">
            <dt>Type</dt><dd>{titleCase(tx.type)}</dd>
            <dt>Amount</dt><dd><StatusBadge value={tx.direction} /> {formatMoney(tx.amount)}</dd>
            <dt>Balance after</dt><dd>{formatMoney(tx.balanceAfter)}</dd>
            <dt>Completed</dt><dd>{formatTime(tx.createdAt)}</dd>
            {tx.bookingId && <><dt>Booking</dt><dd><Link className="text-link" href={`/bookings/${tx.bookingId}`}>{tx.bookingId}</Link></dd></>}
            <dt>Reference</dt><dd>{tx.operationId}</dd>
          </dl>
        )}
      </section>
    </>
  );
}
