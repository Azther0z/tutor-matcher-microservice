"use client";

import { useEffect, useState } from "react";
import { Dropdown } from "@/components/dropdown";
import { LegalModal } from "@/components/legal-modal";
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
  const [open, setOpen] = useState(false);
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
  return (
    <>
      <button type="button" className="button button-quiet" onClick={() => setOpen(true)}>View slip</button>
      {open && (
        <LegalModal open title="Transfer slip" onClose={() => setOpen(false)} actions={false}>
          <img className="slip-full" src={src} alt="Transfer slip" />
        </LegalModal>
      )}
    </>
  );
}

function RequestCard({ topup, onDone }: { topup: Topup; onDone: () => void }) {
  const action = useAction(async () => {
    setRejecting(false);
    setReason("");
    onDone();
  });
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const waiting = topup.status === "PENDING";
  const decide = (decision: "APPROVE" | "REJECT") => void action.run(`/admin/topups/${topup.id}/decision`, { decision, ...(decision === "REJECT" ? { reason: reason.trim() } : {}) }, "POST");
  return (
    <article className="topup-row">
      <div className="topup-row-main">
        <strong>{formatMoney(topup.amount)}</strong>
        <small>{topup.userDisplayName ?? "Unknown user"}, {formatTime(topup.createdAt)}</small>
        {topup.decisionReason && <small>Reason: {topup.decisionReason}</small>}
        {!rejecting && <ActionMessages action={action} />}
      </div>
      <div className="topup-row-side">
        {!waiting && <StatusBadge value={topup.status === "SUCCEEDED" ? "APPROVED" : "REJECTED"} />}
        {topup.slip && <SlipImage topupId={topup.id} />}
        {waiting && (
          <>
            <button className="button button-quiet" disabled={action.pending} onClick={() => setRejecting(true)}>Reject</button>
            <button className="button" disabled={action.pending} onClick={() => decide("APPROVE")}>{action.pending && !rejecting ? "Working…" : "Approve"}</button>
          </>
        )}
      </div>
      {waiting && rejecting && (
        <LegalModal
          open
          title="Reject top-up"
          onClose={() => { setRejecting(false); setReason(""); }}
          actions={
            <div className="button-row" style={{ justifyContent: "flex-end" }}>
              <button className="button button-quiet" disabled={action.pending} onClick={() => { setRejecting(false); setReason(""); }}>Cancel</button>
              <button className="button" disabled={action.pending || !reason.trim()} onClick={() => decide("REJECT")}>{action.pending ? "Working…" : "Reject"}</button>
            </div>
          }
        >
          <ActionMessages action={action} />
          <div className="field">
            <label htmlFor={`reason-${topup.id}`}>Reason</label>
            <textarea id={`reason-${topup.id}`} rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="For example: the amount on the slip does not match" />
          </div>
        </LegalModal>
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
      <header className="page-heading page-heading-row">
        <h1>Top-up requests</h1>
        <div className="tx-filter">
          <Dropdown id="topup-status" value={status} onValueChange={(value) => { setStatus(value); setPage(1); }} options={TABS.map(([value, label]) => ({ value, label }))} />
        </div>
      </header>
      <ResourceState loading={resource.loading} error={resource.error} failure={resource.failure} retry={resource.reload} />
      {resource.data?.items.length === 0 && <p className="tutor-card-meta">No requests here.</p>}
      <div className="topup-list">
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
