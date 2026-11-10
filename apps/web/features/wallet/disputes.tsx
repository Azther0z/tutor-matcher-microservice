"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { use, useCallback, useEffect, useState } from "react";
import { Field, LoadError, Notice } from "@/components/field";
import { Dropdown } from "@/components/dropdown";
import { api, apiResponse, errorMessage, failureOf, fieldErrors, newIdempotencyKey, type Failure } from "@/lib/api";
import { Pager, StatusBadge } from "./common";
import { formatMoney, formatTime, titleCase } from "./format";
import type { AdminDisputeDetail, Dispute, DisputeStatus, Paged } from "./types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function AuditList({ dispute }: { dispute: Dispute }) {
  if (dispute.audit.length === 0) return <p className="muted">No audit entries yet.</p>;
  return (
    <ul className="audit-list">
      {dispute.audit.map((entry) => (
        <li key={entry.id}><strong>{titleCase(entry.action)}</strong> · {formatTime(entry.occurredAt)}{entry.reason && <><br /><span className="small-muted">{entry.reason}</span></>}</li>
      ))}
    </ul>
  );
}

function OutcomeSummary({ dispute }: { dispute: Dispute }) {
  return (
    <>
      <p>Status: <StatusBadge value={dispute.status} /></p>
      <dl className="audit-list">
        <dt>Booking</dt><dd><Link className="text-link" href={`/bookings/${dispute.bookingId}`}>{dispute.bookingId}</Link></dd>
        <dt>Opened</dt><dd>{formatTime(dispute.createdAt)}</dd>
        <dt>Your reason</dt><dd>{dispute.reason}</dd>
        <dt>Refunded</dt><dd>{formatMoney(dispute.refundedAmount)}</dd>
        <dt>Tutor earnings</dt><dd>{dispute.earningsHeld ? "Held while the dispute is open" : "Not held"}</dd>
        {dispute.decisionReason && <><dt>Decision</dt><dd>{dispute.decisionReason}</dd></>}
        {dispute.resolvedAt && <><dt>Resolved</dt><dd>{formatTime(dispute.resolvedAt)}</dd></>}
      </dl>
    </>
  );
}

function OpenDispute({ initialBookingId, onOpened }: { initialBookingId: string; onOpened: () => void }) {
  const [bookingId, setBookingId] = useState(initialBookingId);
  const [reason, setReason] = useState("");
  const [key, setKey] = useState(newIdempotencyKey());
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [fields, setFields] = useState<Record<string, string>>({});

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(""); setFields({});
    const problems: Record<string, string> = {};
    if (!UUID.test(bookingId.trim())) problems.bookingId = "Enter the booking ID from your booking page.";
    if (!reason.trim()) problems.reason = "Tell us what went wrong.";
    if (Object.keys(problems).length) { setFields(problems); return; }
    setPending(true);
    try {
      await api<Dispute>("/disputes", { method: "POST", body: { bookingId: bookingId.trim(), reason: reason.trim() }, idempotencyKey: key });
      setReason(""); setKey(newIdempotencyKey());
      onOpened();
    } catch (e) {
      setFields(fieldErrors(e));
      setError(errorMessage(e, "We couldn’t open the dispute."));
    } finally { setPending(false); }
  }

  return (
    <form className="form" onSubmit={submit} noValidate>
      <h2>Open a dispute</h2>
      <p>Disputes cover a completed lesson that didn’t go as agreed. Opening one holds the tutor’s pending earnings until an admin decides.</p>
      {error && <Notice kind="error">{error}</Notice>}
      <Field id="bookingId" label="Booking ID" value={bookingId} error={fields.bookingId} onChange={(e) => { setBookingId(e.target.value); setKey(newIdempotencyKey()); }} />
      <div className="field">
        <label htmlFor="reason">What went wrong?</label>
        <textarea id="reason" rows={4} maxLength={2000} value={reason} aria-invalid={Boolean(fields.reason)} onChange={(e) => { setReason(e.target.value); setKey(newIdempotencyKey()); }} />
        {fields.reason && <span className="field-error">{fields.reason}</span>}
      </div>
      <button className="button" disabled={pending}>{pending ? "Opening…" : "Open dispute"}</button>
    </form>
  );
}

export function DisputesPage() {
  const params = useSearchParams();
  const prefill = params.get("bookingId") ?? "";
  const [result, setResult] = useState<Paged<Dispute> | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<Failure | null>(null);
  const [notice, setNotice] = useState("");

  const load = useCallback(async (page = 1) => {
    setPending(true); setError(null);
    try { setResult(await api<Paged<Dispute>>(`/disputes?page=${page}&pageSize=20`)); }
    catch (e) { setError(failureOf(e, "We couldn’t load your disputes.")); }
    finally { setPending(false); }
  }, []);
  useEffect(() => { void load(1); }, [load]);

  return (
    <>
      <header className="section-heading"><p className="eyebrow">WALLET</p><h1>Disputes</h1><p>Open a dispute for a completed lesson and follow the decision here.</p></header>
      {notice && <Notice kind="success">{notice}</Notice>}
      <section className="panel"><OpenDispute initialBookingId={prefill} onOpened={() => { setNotice("Your dispute was opened."); void load(1); }} /></section>
      <section className="panel">
        <h2>Your disputes</h2>
        <LoadError failure={error} onRetry={() => void load(1)}/>
        {!result && !error && <p role="status">Loading…</p>}
        {result && result.items.length === 0 && <p className="empty-state">You have no disputes.</p>}
        {result && result.items.length > 0 && (
          <ul className="audit-list">
            {result.items.map((dispute) => (
              <li key={dispute.id}><StatusBadge value={dispute.status} /> Opened {formatTime(dispute.createdAt)} · <Link className="text-link" href={`/disputes/${dispute.id}`}>View</Link></li>
            ))}
          </ul>
        )}
        {result && <Pager meta={result.pagination} onPage={(page) => void load(page)} disabled={pending} />}
      </section>
    </>
  );
}

export function DisputeDetailPage({ params }: { params: Promise<{ disputeId: string }> }) {
  const { disputeId } = use(params);
  const [dispute, setDispute] = useState<Dispute | null>(null);
  const [error, setError] = useState<Failure | null>(null);
  const load = useCallback(() => {
    setError(null);
    api<Dispute>(`/disputes/${disputeId}`).then(setDispute).catch((e) => setError(failureOf(e, "We couldn’t load this dispute.")));
  }, [disputeId]);
  useEffect(() => { load(); }, [load]);
  return (
    <>
      <header className="section-heading"><p className="eyebrow">WALLET</p><h1>Dispute</h1><p><Link className="text-link" href="/disputes">Back to disputes</Link></p></header>
      <section className="panel">
        <LoadError failure={error} onRetry={load} backHref="/disputes" backLabel="Back to disputes"/>
        {!dispute && !error && <p role="status">Loading…</p>}
        {dispute && <><OutcomeSummary dispute={dispute} /><h2>History</h2><AuditList dispute={dispute} /></>}
      </section>
    </>
  );
}

const STATUS_FILTERS: Array<DisputeStatus | ""> = ["", "OPEN", "APPROVED", "REJECTED"];

export function AdminDisputesPage() {
  const [status, setStatus] = useState<DisputeStatus | "">("OPEN");
  const [result, setResult] = useState<Paged<Dispute> | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async (page = 1) => {
    setPending(true); setError("");
    const query = new URLSearchParams({ page: String(page), pageSize: "20" });
    if (status) query.set("status", status);
    try { setResult(await api<Paged<Dispute>>(`/admin/disputes?${query}`)); }
    catch (e) { setError(errorMessage(e, "We couldn’t load disputes.")); }
    finally { setPending(false); }
  }, [status]);
  useEffect(() => { void load(1); }, [load]);

  return (
    <>
      <header className="section-heading"><p className="eyebrow">ADMIN TOOLS</p><h1>Disputes</h1><p>Inspect the evidence, decide the case, and the remedy and audit trail appear here.</p></header>
      <section className="panel">
        <div className="field">
          <label htmlFor="status">Status</label>
          <Dropdown id="status" value={status} onValueChange={(value) => setStatus(value as DisputeStatus | "")} options={
            STATUS_FILTERS.map((value) => ({ value, label: value ? titleCase(value) : "All statuses" }))
          } />
        </div>
        {error && <Notice kind="error">{error}</Notice>}
        {!result && !error && <p role="status">Loading…</p>}
        {result && result.items.length === 0 && <p className="empty-state">No disputes match.</p>}
        {result && result.items.length > 0 && (
          <div className="table-wrap">
            <table className="data-table">
              <thead><tr><th>Opened</th><th>Booking</th><th>Status</th><th>Refunded</th><th><span className="muted">Review</span></th></tr></thead>
              <tbody>
                {result.items.map((dispute) => (
                  <tr key={dispute.id}>
                    <td>{formatTime(dispute.createdAt)}</td>
                    <td>{dispute.bookingId.slice(0, 8)}</td>
                    <td><StatusBadge value={dispute.status} /></td>
                    <td>{formatMoney(dispute.refundedAmount)}</td>
                    <td><Link className="text-link" href={`/admin/disputes/${dispute.id}`}>Review</Link></td>
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

export function AdminDisputeDetailPage({ params }: { params: Promise<{ disputeId: string }> }) {
  const { disputeId } = use(params);
  const [detail, setDetail] = useState<AdminDisputeDetail | null>(null);
  const [etag, setEtag] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [decision, setDecision] = useState<"APPROVE_FULL_REMAINDER" | "REJECT">("APPROVE_FULL_REMAINDER");
  const [reason, setReason] = useState("");
  const [reasonError, setReasonError] = useState("");
  const [key, setKey] = useState(newIdempotencyKey());
  const [pending, setPending] = useState(false);

  const load = useCallback(async () => {
    try {
      const result = await apiResponse<AdminDisputeDetail>(`/admin/disputes/${disputeId}`);
      setDetail(result.data); setEtag(result.headers.get("ETag") ?? `"${result.data.dispute.revision}"`); setError("");
    } catch (e) { setError(errorMessage(e, "We couldn’t load this dispute.")); }
  }, [disputeId]);
  useEffect(() => { void load(); }, [load]);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(""); setNotice(""); setReasonError("");
    if (!reason.trim()) { setReasonError("Enter the reason for your decision. It is recorded in the audit trail."); return; }
    setPending(true);
    try {
      await api<Dispute>(`/admin/disputes/${disputeId}/decision`, { method: "POST", body: { decision, reason: reason.trim() }, idempotencyKey: key, ifMatch: etag });
      setKey(newIdempotencyKey()); setReason("");
      setNotice(decision === "REJECT" ? "Dispute rejected. The tutor’s earnings follow the normal clearing rules." : "Dispute approved. The remaining paid amount was refunded.");
      await load();
    } catch (e) {
      setError(errorMessage(e, "We couldn’t record the decision."));
      if ((e as { status?: number }).status === 412) await load();
    } finally { setPending(false); }
  }

  const open = detail?.dispute.status === "OPEN";
  return (
    <>
      <header className="section-heading"><p className="eyebrow">ADMIN TOOLS</p><h1>Dispute review</h1><p><Link className="text-link" href="/admin/disputes">Back to disputes</Link></p></header>
      {notice && <Notice kind="success">{notice}</Notice>}
      {error && <Notice kind="error">{error}</Notice>}
      {!detail && !error && <p role="status">Loading…</p>}
      {detail && (
        <>
          <section className="panel">
            <h2>Evidence</h2>
            <p>Status: <StatusBadge value={detail.dispute.status} /></p>
            <dl className="audit-list">
              <dt>Student</dt><dd>{detail.studentDisplayName}</dd>
              <dt>Tutor</dt><dd>{detail.tutorDisplayName}</dd>
              <dt>Student’s reason</dt><dd>{detail.dispute.reason}</dd>
              <dt>Booking</dt><dd>{titleCase(detail.booking.status)} · {formatTime(detail.booking.startsAt)} to {formatTime(detail.booking.endsAt)}</dd>
              <dt>Completed</dt><dd>{formatTime(detail.booking.completedAt)}</dd>
              <dt>Cancelled</dt><dd>{formatTime(detail.booking.cancelledAt)}</dd>
            </dl>
          </section>
          <section className="panel">
            <h2>Money</h2>
            <dl className="audit-list">
              <dt>Paid</dt><dd>{formatMoney(detail.financial.paid)}</dd>
              <dt>Already refunded</dt><dd>{formatMoney(detail.financial.refunded)}</dd>
              <dt>Pending tutor earning</dt><dd>{formatMoney(detail.financial.pendingEarning)}{detail.financial.disputeHeld ? " (held)" : ""}</dd>
              <dt>Platform fee</dt><dd>{formatMoney(detail.financial.fee)}</dd>
              <dt>Clearing due</dt><dd>{formatTime(detail.financial.clearingDueAt)}</dd>
              <dt>Refunded by this dispute</dt><dd>{formatMoney(detail.dispute.refundedAmount)}</dd>
            </dl>
            {detail.transactions.length > 0 && (
              <div className="table-wrap">
                <table className="data-table">
                  <caption className="muted">Related wallet movements</caption>
                  <thead><tr><th>When</th><th>Type</th><th>Amount</th></tr></thead>
                  <tbody>{detail.transactions.map((tx) => <tr key={tx.id}><td>{formatTime(tx.createdAt)}</td><td>{titleCase(tx.type)}</td><td>{formatMoney(tx.amount)}</td></tr>)}</tbody>
                </table>
              </div>
            )}
          </section>
          <section className="panel">
            <h2>Audit trail</h2>
            {detail.dispute.decisionReason && <p><strong>Decision:</strong> {detail.dispute.decisionReason}</p>}
            <AuditList dispute={detail.dispute} />
          </section>
          {open && (
            <section className="panel">
              <form className="form" onSubmit={submit} noValidate>
                <h2>Decide this dispute</h2>
                <fieldset className="field">
                  <legend>Decision</legend>
                  <label className="check-row"><input type="radio" name="decision" checked={decision === "APPROVE_FULL_REMAINDER"} onChange={() => { setDecision("APPROVE_FULL_REMAINDER"); setKey(newIdempotencyKey()); }} /><span>Approve: refund the full remaining paid amount</span></label>
                  <label className="check-row"><input type="radio" name="decision" checked={decision === "REJECT"} onChange={() => { setDecision("REJECT"); setKey(newIdempotencyKey()); }} /><span>Reject: no refund</span></label>
                </fieldset>
                <div className="field">
                  <label htmlFor="reason">Reason (kept in the audit trail)</label>
                  <textarea id="reason" rows={3} maxLength={2000} value={reason} aria-invalid={Boolean(reasonError)} onChange={(e) => { setReason(e.target.value); setKey(newIdempotencyKey()); }} />
                  {reasonError && <span className="field-error">{reasonError}</span>}
                </div>
                <button className="button" disabled={pending}>{pending ? "Recording…" : "Record decision"}</button>
              </form>
            </section>
          )}
        </>
      )}
    </>
  );
}
