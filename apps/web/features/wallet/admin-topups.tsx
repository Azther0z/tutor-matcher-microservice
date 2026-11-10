"use client";

import { useEffect, useState } from "react";
import { Notice } from "@/components/field";
import { ActionMessages, ResourceState, useAction, useResource } from "@/features/tutor/common";
import { sessionToken } from "@/lib/api";
import { RequireAuth } from "@/lib/auth-context";
import { Pager, StatusBadge } from "./common";
import { formatMoney, formatTime } from "./format";
import type { Topup } from "./types";

const TABS = [["PENDING", "Waiting"], ["SUCCEEDED", "Approved"], ["FAILED", "Rejected"], ["", "All"]] as const;

/** Loads the slip with the session token (an <img> cannot send it) and shows it. */
function SlipImage({ topupId }: { topupId: string }) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let url: string | null = null;
    let cancelled = false;
    fetch(`/api/admin/topups/${topupId}/slip`, { headers: { Authorization: `Bearer ${sessionToken.read() ?? ""}` }, cache: "no-store" })
      .then((response) => (response.ok ? response.blob() : Promise.reject(new Error("slip"))))
      .then((blob) => { if (!cancelled) { url = URL.createObjectURL(blob); setSrc(url); } })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; if (url) URL.revokeObjectURL(url); };
  }, [topupId]);
  if (failed) return <p className="small-muted">The slip image could not be loaded.</p>;
  if (!src) return <p className="small-muted" role="status">Loading slip…</p>;
  return <a href={src} target="_blank" rel="noreferrer"><img className="slip-image" src={src} alt="Transfer slip" /></a>;
}

function RequestCard({ topup, onDone }: { topup: Topup; onDone: () => void }) {
  const action = useAction(onDone);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const waiting = topup.status === "PENDING";
  const decide = (decision: "APPROVE" | "REJECT") => void action.run(`/admin/topups/${topup.id}/decision`, { decision, ...(decision === "REJECT" ? { reason: reason.trim() } : {}) }, "POST");
  return (
    <article className="panel">
      <div className="stat-line">
        <StatusBadge value={topup.status === "SUCCEEDED" ? "APPROVED" : topup.status === "FAILED" ? "REJECTED" : "PENDING"} />
        <span>{formatTime(topup.createdAt)}</span>
      </div>
      <h2>{formatMoney(topup.amount)}</h2>
      <p>From <strong>{topup.userDisplayName ?? "Unknown user"}</strong></p>
      {topup.slip && <SlipImage topupId={topup.id} />}
      {topup.decisionReason && <p className="muted">Reason: {topup.decisionReason}</p>}
      {topup.decidedAt && <p className="small-muted">Decided {formatTime(topup.decidedAt)}</p>}
      <ActionMessages action={action} />
      {waiting && !rejecting && (
        <div className="button-row">
          <button className="button" disabled={action.pending} onClick={() => decide("APPROVE")}>{action.pending ? "Working…" : "Approve"}</button>
          <button className="button button-danger" disabled={action.pending} onClick={() => setRejecting(true)}>Reject</button>
        </div>
      )}
      {waiting && rejecting && (
        <div className="form">
          <div className="field">
            <label htmlFor={`reason-${topup.id}`}>Reason for rejecting</label>
            <textarea id={`reason-${topup.id}`} rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="For example: the amount on the slip does not match" />
          </div>
          <div className="button-row">
            <button className="button button-danger" disabled={action.pending || !reason.trim()} onClick={() => decide("REJECT")}>{action.pending ? "Working…" : "Confirm rejection"}</button>
            <button className="button button-quiet" disabled={action.pending} onClick={() => { setRejecting(false); setReason(""); }}>Cancel</button>
          </div>
        </div>
      )}
    </article>
  );
}

function Requests() {
  const [status, setStatus] = useState<string>("PENDING");
  const [page, setPage] = useState(1);
  const resource = useResource<{ items: Topup[]; pagination: { page: number; pageSize: number; totalItems: number; totalPages: number } }>(
    `/admin/topups?page=${page}&pageSize=12${status ? `&status=${status}` : ""}`,
  );
  return (
    <>
      <header className="section-heading">
        <p className="eyebrow">ADMIN</p>
        <h1>Top-up requests</h1>
        <p>Check each transfer slip against the amount, then approve to credit the student's wallet or reject with a reason.</p>
      </header>
      <div className="view-switch" role="group" aria-label="Request status">
        {TABS.map(([value, label]) => (
          <button key={label} className={`button ${status === value ? "" : "button-quiet"}`} aria-pressed={status === value} onClick={() => { setStatus(value); setPage(1); }}>{label}</button>
        ))}
      </div>
      <ResourceState loading={resource.loading} error={resource.error} failure={resource.failure} retry={resource.reload} />
      {resource.data?.items.length === 0 && <Notice kind="info">No requests here.</Notice>}
      <div className="account-grid">
        {resource.data?.items.map((topup) => <RequestCard key={topup.id} topup={topup} onDone={resource.reload} />)}
      </div>
      {resource.data && <Pager meta={resource.data.pagination} onPage={setPage} disabled={resource.loading} />}
    </>
  );
}

export function AdminTopupsPage() {
  return (
    <RequireAuth admin>
      <Requests />
    </RequireAuth>
  );
}
