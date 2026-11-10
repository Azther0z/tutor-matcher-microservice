"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Field, Notice } from "@/components/field";
import { api, errorMessage, fieldErrors, newIdempotencyKey } from "@/lib/api";
import { DemoBanner } from "./common";
import type { Bank, Paged, PayoutAccount } from "./types";

const MAX_ACCOUNTS = 5;

function AddAccount({ banks, onAdded, full }: { banks: Bank[]; onAdded: () => void; full: boolean }) {
  const [bankCode, setBankCode] = useState("");
  const [holder, setHolder] = useState("");
  const [number, setNumber] = useState("");
  const [makeDefault, setMakeDefault] = useState(false);
  const [key, setKey] = useState(newIdempotencyKey());
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [fields, setFields] = useState<Record<string, string>>({});
  const changed = <T,>(set: (value: T) => void) => (value: T) => { set(value); setKey(newIdempotencyKey()); };

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(""); setFields({});
    const problems: Record<string, string> = {};
    if (!bankCode) problems.bankCode = "Choose a bank.";
    if (!holder.trim()) problems.accountHolderName = "Enter the account holder name.";
    if (!/^(?:[ -]*[0-9]){10,15}[ -]*$/.test(number)) problems.accountNumber = "Enter 10 to 15 digits. Spaces and dashes are allowed.";
    if (Object.keys(problems).length) { setFields(problems); return; }
    setPending(true);
    try {
      await api<PayoutAccount>("/payout-accounts", { method: "POST", body: { bankCode, accountHolderName: holder.trim(), accountNumber: number, makeDefault }, idempotencyKey: key });
      setBankCode(""); setHolder(""); setNumber(""); setMakeDefault(false); setKey(newIdempotencyKey());
      onAdded();
    } catch (e) {
      setFields(fieldErrors(e));
      setError(errorMessage(e, "We couldn’t add this payout account."));
    } finally { setPending(false); }
  }

  if (full) return <Notice kind="info">You have {MAX_ACCOUNTS} payout accounts, the maximum. Remove one to add another.</Notice>;
  return (
    <form className="form" onSubmit={submit} noValidate>
      <h2>Add a payout account</h2>
      {error && <Notice kind="error">{error}</Notice>}
      <div className="field">
        <label htmlFor="bankCode">Bank</label>
        <select id="bankCode" value={bankCode} aria-invalid={Boolean(fields.bankCode)} onChange={(e) => changed(setBankCode)(e.target.value)}>
          <option value="">Choose a bank</option>
          {banks.map((bank) => <option key={bank.code} value={bank.code}>{bank.name}</option>)}
        </select>
        {fields.bankCode && <span className="field-error">{fields.bankCode}</span>}
      </div>
      <Field id="accountHolderName" label="Account holder name" maxLength={200} value={holder} error={fields.accountHolderName} onChange={(e) => changed(setHolder)(e.target.value)} />
      <Field id="accountNumber" label="Account number" inputMode="numeric" autoComplete="off" value={number} error={fields.accountNumber} onChange={(e) => changed(setNumber)(e.target.value)} />
      <label className="check-row"><input type="checkbox" checked={makeDefault} onChange={(e) => changed(setMakeDefault)(e.target.checked)} /><span>Make this my default account</span></label>
      <button className="button" disabled={pending}>{pending ? "Adding…" : "Add account"}</button>
    </form>
  );
}

export function PayoutAccountsPage() {
  const [accounts, setAccounts] = useState<PayoutAccount[] | null>(null);
  const [banks, setBanks] = useState<Bank[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");

  const load = useCallback(async () => {
    setError("");
    try {
      const [list, bankList] = await Promise.all([
        api<Paged<PayoutAccount>>("/payout-accounts?page=1&pageSize=100"),
        api<{ items: Bank[] }>("/payout-accounts/banks"),
      ]);
      setAccounts(list.items); setBanks(bankList.items);
    } catch (e) { setError(errorMessage(e, "We couldn’t load your payout accounts.")); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function act(account: PayoutAccount, action: "default" | "delete") {
    setBusy(account.id); setError(""); setNotice("");
    const options = { idempotencyKey: newIdempotencyKey(), ifMatch: `"${account.revision}"` };
    try {
      if (action === "default") { await api(`/payout-accounts/${account.id}/default`, { method: "PATCH", ...options }); setNotice("Default account updated."); }
      else { await api(`/payout-accounts/${account.id}`, { method: "DELETE", ...options }); setNotice("Payout account removed. Past payouts keep their original destination."); }
      await load();
    } catch (e) {
      setError(errorMessage(e, "That change didn’t go through."));
      if ((e as { status?: number }).status === 412) await load();
    } finally { setBusy(""); }
  }

  const bankName = (code: string) => banks.find((bank) => bank.code === code)?.name ?? code;
  return (
    <>
      <header className="section-heading"><p className="eyebrow">TUTOR · PAYOUTS</p><h1>Payout accounts</h1><p>Up to {MAX_ACCOUNTS} accounts. Numbers are shown masked. <Link className="text-link" href="/wallet/payouts">Go to payouts</Link></p></header>
      <DemoBanner />
      {notice && <Notice kind="success">{notice}</Notice>}
      {error && <Notice kind="error">{error}</Notice>}
      <section className="panel">
        {!accounts && !error && <p role="status">Loading…</p>}
        {accounts && accounts.length === 0 && <p className="empty-state">No payout accounts yet.</p>}
        {accounts && accounts.length > 0 && (
          <ul className="audit-list">
            {accounts.map((account) => (
              <li key={account.id}>
                <strong>{bankName(account.bankCode)}</strong> {account.maskedAccountNumber} · {account.accountHolderName} {account.isDefault && <span className="badge">Default</span>}
                <div className="button-row">
                  {!account.isDefault && <button className="button button-quiet" disabled={busy === account.id} onClick={() => void act(account, "default")}>Make default</button>}
                  <button className="button button-danger" disabled={busy === account.id} onClick={() => void act(account, "delete")}>Remove</button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="panel">
        <AddAccount banks={banks} full={(accounts?.length ?? 0) >= MAX_ACCOUNTS} onAdded={() => { setNotice("Payout account added."); void load(); }} />
      </section>
    </>
  );
}
