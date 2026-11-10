"use client";

import Link from "next/link";
import { use, useCallback, useEffect, useState } from "react";
import { Field, Notice } from "@/components/field";
import { Dropdown } from "@/components/dropdown";
import { ApiError, api, errorMessage, fieldErrors, newIdempotencyKey } from "@/lib/api";
import { DemoBanner, Pager, StatusBadge, useOperation } from "./common";
import { formatMoney, formatTime, normalizeAmount } from "./format";
import type { OperationRef, Paged, Payout, PayoutAccount, WalletOverview } from "./types";

const OUTCOME_TEXT: Record<Payout["status"], string> = {
  PENDING: "Waiting for the demonstration provider. The amount is reserved and cannot be spent.",
  SUCCEEDED: "The payout completed. The reserved amount became a completed movement.",
  FAILED: "The payout failed definitively. The reservation was released back to your available balance.",
  UNKNOWN: "The outcome is unknown. The amount stays reserved until the provider resolves it.",
};

function CreatePayout({ accounts, available, onCreated }: { accounts: PayoutAccount[]; available: string; onCreated: (payout: Payout | OperationRef) => void }) {
  const defaultAccount = accounts.find((account) => account.isDefault) ?? accounts[0];
  const [accountId, setAccountId] = useState(defaultAccount?.id ?? "");
  const [amount, setAmount] = useState("");
  const [key, setKey] = useState(newIdempotencyKey());
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [fields, setFields] = useState<Record<string, string>>({});
  useEffect(() => { if (!accountId && defaultAccount) setAccountId(defaultAccount.id); }, [accountId, defaultAccount]);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(""); setFields({});
    const normalized = normalizeAmount(amount);
    if (!normalized) { setFields({ amount: "Enter an amount from 0.01 to 100,000.00 with at most two decimal places." }); return; }
    if (!accountId) { setFields({ payoutAccountId: "Choose a payout account." }); return; }
    setPending(true);
    try {
      const created = await api<Payout | OperationRef>("/payouts", { method: "POST", body: { amount: normalized, payoutAccountId: accountId }, idempotencyKey: key });
      setAmount(""); setKey(newIdempotencyKey());
      onCreated(created);
    } catch (e) {
      setFields(fieldErrors(e));
      if (e instanceof ApiError && e.status === 402) setError("Your available balance is too low. Pending earnings can’t fund a payout.");
      else setError(errorMessage(e, "We couldn’t start the payout. Nothing was reserved."));
    } finally { setPending(false); }
  }

  if (accounts.length === 0) return <Notice kind="info">Add a payout account before requesting a payout. <Link className="text-link" href="/wallet/payout-accounts">Add an account</Link></Notice>;
  return (
    <form className="form" onSubmit={submit} noValidate>
      <h2>Request a payout</h2>
      <p>Available to pay out: <strong>THB {available}</strong>. Pending earnings can’t be paid out.</p>
      {error && <Notice kind="error">{error}</Notice>}
      <div className="field">
        <label htmlFor="payoutAccountId">Payout account</label>
        <Dropdown id="payoutAccountId" value={accountId} aria-invalid={Boolean(fields.payoutAccountId)} aria-describedby={fields.payoutAccountId ? "payoutAccountId-error" : undefined} onValueChange={(value) => { setAccountId(value); setKey(newIdempotencyKey()); }} options={
          accounts.map((account) => ({ value: account.id, label: `${account.maskedAccountNumber}, ${account.accountHolderName}${account.isDefault ? " (default)" : ""}` }))
        } />
        {fields.payoutAccountId && <span className="field-error" id="payoutAccountId-error">{fields.payoutAccountId}</span>}
      </div>
      <Field id="amount" label="Amount (THB)" inputMode="decimal" autoComplete="off" value={amount} error={fields.amount} onChange={(e) => { setAmount(e.target.value); setKey(newIdempotencyKey()); }} />
      <button className="button" disabled={pending}>{pending ? "Requesting…" : "Request payout"}</button>
    </form>
  );
}

export function PayoutsPage() {
  const [payouts, setPayouts] = useState<Paged<Payout> | null>(null);
  const [accounts, setAccounts] = useState<PayoutAccount[]>([]);
  const [available, setAvailable] = useState("0.00");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState(false);

  const load = useCallback(async (page = 1) => {
    setPending(true); setError("");
    try {
      const [list, accountList, wallet] = await Promise.all([
        api<Paged<Payout>>(`/payouts?page=${page}&pageSize=20`),
        api<Paged<PayoutAccount>>("/payout-accounts?page=1&pageSize=100"),
        api<WalletOverview>("/wallet"),
      ]);
      setPayouts(list); setAccounts(accountList.items); setAvailable(wallet.availableBalance.amount);
    } catch (e) { setError(errorMessage(e, "We couldn’t load your payouts.")); }
    finally { setPending(false); }
  }, []);
  useEffect(() => { void load(1); }, [load]);

  return (
    <>
      <header className="section-heading"><p className="eyebrow">TUTOR PAYOUTS</p><h1>Payouts</h1><p><Link className="text-link" href="/wallet/payout-accounts">Manage payout accounts</Link></p></header>
      <DemoBanner />
      {notice && <Notice kind="success">{notice}</Notice>}
      {error && <Notice kind="error">{error}</Notice>}
      <section className="panel">
        <CreatePayout accounts={accounts} available={available} onCreated={() => { setNotice("Payout requested. The amount is reserved until the provider reports an outcome."); void load(1); }} />
      </section>
      <section className="panel">
        <h2>Payout history</h2>
        {!payouts && !error && <p role="status">Loading…</p>}
        {payouts && payouts.items.length === 0 && <p className="empty-state">No payouts yet.</p>}
        {payouts && payouts.items.length > 0 && (
          <div className="table-wrap">
            <table className="data-table">
              <thead><tr><th>Requested</th><th>Amount</th><th>Destination</th><th>Status</th><th><span className="muted">Details</span></th></tr></thead>
              <tbody>
                {payouts.items.map((payout) => (
                  <tr key={payout.id}>
                    <td>{formatTime(payout.createdAt)}</td>
                    <td>{formatMoney(payout.amount)}</td>
                    <td>{payout.payoutAccount.maskedAccountNumber}</td>
                    <td><StatusBadge value={payout.status} /></td>
                    <td><Link className="text-link" href={`/wallet/payouts/${payout.id}`}>View</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {payouts && <Pager meta={payouts.pagination} onPage={(page) => void load(page)} disabled={pending} />}
      </section>
    </>
  );
}

export function PayoutDetailPage({ params }: { params: Promise<{ payoutId: string }> }) {
  const { payoutId } = use(params);
  const [payout, setPayout] = useState<Payout | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    try { setPayout(await api<Payout>(`/payouts/${payoutId}`)); setError(""); }
    catch (e) { setError(errorMessage(e, "We couldn’t load this payout.")); }
  }, [payoutId]);
  useEffect(() => { void load(); }, [load]);
  const operation = useOperation(payout?.operation, () => void load());
  return (
    <>
      <header className="section-heading"><p className="eyebrow">TUTOR PAYOUTS</p><h1>Payout</h1><p><Link className="text-link" href="/wallet/payouts">Back to payouts</Link></p></header>
      <DemoBanner />
      {error && <Notice kind="error">{error} <button className="button button-quiet" onClick={() => void load()}>Try again</button></Notice>}
      {!payout && !error && <p role="status">Loading…</p>}
      {payout && (
        <section className="panel">
          <div className="stat-line"><span className="tiny-label">AMOUNT</span><strong>{formatMoney(payout.amount)}</strong></div>
          <p>Status: <StatusBadge value={payout.status} /></p>
          <p role="status">{OUTCOME_TEXT[payout.status]}</p>
          {operation?.error && <p className="small-muted">{operation.error}</p>}
          {operation?.status === "TIMEOUT" && <Notice kind="info">Still waiting. You can leave this page; the result will appear in your payout history.</Notice>}
          <dl className="audit-list">
            <dt>Destination</dt><dd>{payout.payoutAccount.maskedAccountNumber}, {payout.payoutAccount.accountHolderName}</dd>
            <dt>Requested</dt><dd>{formatTime(payout.createdAt)}</dd>
            <dt>Resolved</dt><dd>{formatTime(payout.resolvedAt)}</dd>
          </dl>
        </section>
      )}
    </>
  );
}
