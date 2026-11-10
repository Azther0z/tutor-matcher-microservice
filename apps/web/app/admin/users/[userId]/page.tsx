"use client";

import { use, useCallback, useEffect, useState } from "react";
import { RequireAuth } from "@/lib/auth-context";
import { Field, Notice } from "@/components/field";
import { Avatar } from "@/components/avatar";
import { LegalModal } from "@/components/legal-modal";
import { StatusBadge } from "@/features/wallet/common";
import { formatTime } from "@/features/wallet/format";
import { apiResponse, errorMessage, newIdempotencyKey } from "@/lib/api";
import type { AccountDetail } from "@/lib/types";

const ACTION_LABEL: Record<string, string> = {
  SUSPEND: "Suspend access",
  BAN: "Permanently ban",
  RESTORE: "Restore access",
};

function UserDetail({ userId }: { userId: string }) {
  const [detail, setDetail] = useState<AccountDetail | null>(null);
  const [etag, setEtag] = useState("");
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [reasonError, setReasonError] = useState("");
  const [key, setKey] = useState(newIdempotencyKey());
  const [open, setOpen] = useState(false);
  const [action, setAction] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const r = await apiResponse<AccountDetail>(`/admin/users/${encodeURIComponent(userId)}`);
      setDetail(r.data);
      setEtag(r.headers.get("ETag") ?? `"${r.data.revision}"`);
    } catch (e) {
      setError(errorMessage(e, "Could not load this account."));
    } finally {
      setLoading(false);
    }
  }, [userId]);
  useEffect(() => { void load(); }, [load]);

  const status = detail?.user.status;
  const options = status === "ACTIVE" ? ["SUSPEND", "BAN"] : status === "SUSPENDED" || status === "DEACTIVATED" ? ["RESTORE", "BAN"] : [];

  async function transition(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError("");
    setNotice("");
    setReasonError("");
    const reason = String(new FormData(event.currentTarget).get("reason") ?? "").trim();
    if (!action) { setError("Choose an action first."); setPending(false); return; }
    if (!reason) { setReasonError("Enter a reason for this account action."); setPending(false); return; }
    if (!options.includes(action)) { setError("That action is not available for the account’s current status."); setPending(false); return; }
    try {
      const r = await apiResponse<AccountDetail>(`/admin/users/${encodeURIComponent(userId)}/restrictions`, {
        method: "POST", body: { action, reason }, idempotencyKey: key, ifMatch: etag,
      });
      setDetail(r.data);
      setEtag(r.headers.get("ETag") ?? `"${r.data.revision}"`);
      setKey(newIdempotencyKey());
      setNotice(`Account action ${action.toLowerCase()} was recorded. Restored accounts must log in again; revoked sessions are never revived.`);
      setOpen(false);
      setAction("");
    } catch (e) {
      setError(errorMessage(e, "Could not update account access."));
      if ((e as { status?: number }).status === 412) void load();
    } finally {
      setPending(false);
    }
  }

  if (loading && !detail) return <p role="status" className="tutor-card-meta">Loading account record…</p>;
  if (!detail) return <Notice kind="error">{error || "Account record is unavailable."}</Notice>;
  const user = detail.user;
  const fullName = `${user.firstName} ${user.lastName}`;
  return (
    <>
      <header className="page-heading"><h1>Account</h1></header>
      {notice && <Notice kind="success">{notice}</Notice>}
      {error && !open && <Notice kind="error">{error}</Notice>}
      <section className="panel booking-new">
        <StatusBadge value={user.status} corner />
        <div className="chat-head">
          <Avatar name={fullName} size={48} />
          <div className="booking-title">
            <h2>{fullName}</h2>
            <p className="tutor-card-meta">{user.email}</p>
          </div>
        </div>
        <div className="summary-rows">
          <div>
            <span>Capabilities</span>
            <strong>{user.capabilities.map((value) => value.charAt(0) + value.slice(1).toLowerCase()).join(", ")}</strong>
          </div>
          <div>
            <span>Revision</span>
            <strong>{user.revision}</strong>
          </div>
        </div>
        <div className="slot-footer flush">
          <span className="tutor-card-meta">
            {options.length > 0
              ? "Restriction actions keep existing bookings, funds and history."
              : "Banned accounts are permanent and cannot be restored."}
          </span>
          {options.length > 0 && (
            <button type="button" className="button" onClick={() => { setError(""); setOpen(true); }}>Change access</button>
          )}
        </div>
      </section>

      <section className="panel wallet-recent">
        <h2>Restriction history</h2>
        {detail.audit.length === 0 && <p className="tutor-card-meta">No restriction actions have been recorded.</p>}
        {detail.audit.map((entry) => (
          <div key={entry.id} className="audit-row">
            <span>
              <strong>{ACTION_LABEL[entry.action] ?? entry.action}</strong>
              <small>{entry.reason || "No reason recorded"}</small>
            </span>
            <time dateTime={entry.occurredAt}>{formatTime(entry.occurredAt)}</time>
          </div>
        ))}
      </section>

      <LegalModal
        open={open}
        title="Change access"
        onClose={() => setOpen(false)}
        actions={
          <div className="button-row" style={{ justifyContent: "flex-end" }}>
            <button type="button" className="button button-quiet" onClick={() => setOpen(false)}>Cancel</button>
            <button type="submit" form="access-form" className="button" disabled={pending}>{pending ? "Saving…" : "Record action"}</button>
          </div>
        }
      >
        <form id="access-form" className="topup-step" onSubmit={transition} noValidate>
          {error && <Notice kind="error">{error}</Notice>}
          <div className="field">
            <span className="field-label">Account action</span>
            <div className="topup-quick" role="group" aria-label="Account action">
              {options.map((value) => (
                <button type="button" key={value} className="topup-chip" aria-pressed={action === value} onClick={() => setAction(value)}>
                  {ACTION_LABEL[value]}
                </button>
              ))}
            </div>
          </div>
          <Field id="reason" label="Reason (required)" maxLength={500} required error={reasonError} />
        </form>
      </LegalModal>
    </>
  );
}

export default function AdminUserDetailPage({ params }: { params: Promise<{ userId: string }> }) {
  const { userId } = use(params);
  return <RequireAuth admin><UserDetail userId={userId} /></RequireAuth>;
}
