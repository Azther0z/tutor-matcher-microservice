"use client";

import { useState } from "react";
import { Field, Notice } from "@/components/field";
import { Dropdown } from "@/components/dropdown";
import { api, ApiError, errorMessage, fieldErrors, newIdempotencyKey } from "@/lib/api";
import { DemoBanner, StatusBadge } from "./common";
import { formatMoney } from "./format";
import type { Payout, Topup } from "./types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
type Kind = "topups" | "payouts";
type Outcome = "SUCCEEDED" | "FAILED" | "UNKNOWN";

export function DemoFinancePage() {
  const [kind, setKind] = useState<Kind>("topups");
  const [resourceId, setResourceId] = useState("");
  const [providerReference, setProviderReference] = useState("");
  const [outcome, setOutcome] = useState<Outcome>("SUCCEEDED");
  const [key, setKey] = useState(newIdempotencyKey());
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [fields, setFields] = useState<Record<string, string>>({});
  const [result, setResult] = useState<Topup | Payout | null>(null);
  const changed = <T,>(set: (value: T) => void) => (value: T) => { set(value); setKey(newIdempotencyKey()); };

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(""); setFields({}); setResult(null);
    const problems: Record<string, string> = {};
    if (!UUID.test(resourceId.trim())) problems.resourceId = "Enter the top-up or payout ID.";
    if (!UUID.test(providerReference.trim())) problems.providerReference = "Enter the provider reference shown with the resource.";
    if (Object.keys(problems).length) { setFields(problems); return; }
    setPending(true);
    try {
      setResult(await api<Topup | Payout>(`/demo/${kind}/${resourceId.trim()}/outcome`, { method: "POST", body: { outcome, providerReference: providerReference.trim() }, idempotencyKey: key }));
      setKey(newIdempotencyKey());
    } catch (e) {
      setFields(fieldErrors(e));
      if (e instanceof ApiError && e.status === 403) setError("Demo controls are turned off, or this isn’t a synthetic resource.");
      else setError(errorMessage(e, "We couldn’t record that outcome."));
    } finally { setPending(false); }
  }

  return (
    <>
      <header className="section-heading">
        <h1>Simulated provider outcomes</h1>
        <p>Stand in for the payment provider. Only an admin can resolve a simulated top-up or payout, and only for synthetic resources.</p>
      </header>
      <DemoBanner />
      <section className="panel">
        <form className="form" onSubmit={submit} noValidate>
          {error && <Notice kind="error">{error}</Notice>}
          <div className="field">
            <label htmlFor="kind">Resource</label>
            <Dropdown id="kind" value={kind} onValueChange={(value) => changed(setKind)(value as Kind)} options={[
              { value: "topups", label: "Top-up" },
              { value: "payouts", label: "Payout" },
            ]} />
          </div>
          <Field id="resourceId" label="Top-up or payout ID" autoComplete="off" value={resourceId} error={fields.resourceId} onChange={(e) => changed(setResourceId)(e.target.value)} />
          <Field id="providerReference" label="Provider reference" autoComplete="off" value={providerReference} error={fields.providerReference} onChange={(e) => changed(setProviderReference)(e.target.value)} />
          <div className="field">
            <label htmlFor="outcome">Outcome</label>
            <Dropdown id="outcome" value={outcome} onValueChange={(value) => changed(setOutcome)(value as Outcome)} options={[
              { value: "SUCCEEDED", label: "Succeeded" },
              { value: "FAILED", label: "Failed" },
              { value: "UNKNOWN", label: "Unknown" },
            ]} />
          </div>
          <button className="button" disabled={pending}>{pending ? "Recording…" : "Record outcome"}</button>
        </form>
      </section>
      {result && (
        <Notice kind="success">
          Recorded. {kind === "topups" ? "Top-up" : "Payout"} of {formatMoney(result.amount)} is now <StatusBadge value={result.status} />.
        </Notice>
      )}
    </>
  );
}
