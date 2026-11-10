"use client";

import Link from "next/link";
import { use, useCallback, useEffect, useState } from "react";
import { RequireAuth } from "@/lib/auth-context";
import { Field, Notice } from "@/components/field";
import { apiResponse, errorMessage, newIdempotencyKey } from "@/lib/api";
import type { AccountDetail } from "@/lib/types";

function UserDetail({ userId }: { userId: string }) {
  const [detail, setDetail] = useState<AccountDetail | null>(null); const [etag, setEtag] = useState(""); const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false); const [error, setError] = useState(""); const [notice, setNotice] = useState(""); const [reasonError, setReasonError] = useState(""); const [key, setKey] = useState(newIdempotencyKey());
  const load = useCallback(async () => {
    setLoading(true); setError("");
    try { const r = await apiResponse<AccountDetail>(`/admin/users/${encodeURIComponent(userId)}`); setDetail(r.data); setEtag(r.headers.get("ETag") ?? `"${r.data.revision}"`); }
    catch (e) { setError(errorMessage(e, "Could not load this account.")); }
    finally { setLoading(false); }
  }, [userId]);
  useEffect(() => { void load(); }, [load]);
  const status = detail?.user.status;
  const options = status === "ACTIVE" ? ["SUSPEND", "BAN"] : status === "SUSPENDED" || status === "DEACTIVATED" ? ["RESTORE", "BAN"] : [];
  async function transition(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setPending(true); setError(""); setNotice(""); setReasonError("");
    const form = new FormData(event.currentTarget); const action = String(form.get("action") ?? ""); const reason = String(form.get("reason") ?? "").trim();
    if (!reason) { setReasonError("Enter a reason for this account action."); setPending(false); return; }
    if (!options.includes(action)) { setError("That action is not available for the account’s current status."); setPending(false); return; }
    try { const r = await apiResponse<AccountDetail>(`/admin/users/${encodeURIComponent(userId)}/restrictions`, { method: "POST", body: { action, reason }, idempotencyKey: key, ifMatch: etag }); setDetail(r.data); setEtag(r.headers.get("ETag") ?? `"${r.data.revision}"`); setKey(newIdempotencyKey()); setNotice(`Account action ${action.toLowerCase()} was recorded.`); }
    catch (e) { setError(errorMessage(e, "Could not update account access.")); if ((e as { status?: number }).status === 412) void load(); }
    finally { setPending(false); }
  }
  if (loading) return <p role="status">Loading account record…</p>;
  if (!detail) return <><Notice kind="error">{error || "Account record is unavailable."}</Notice><Link href="/admin/users">Back to accounts</Link></>;
  const user = detail.user;
  return <><p className="form-footer"><Link href="/admin/users">← All accounts</Link></p><header className="section-heading"><p className="eyebrow">ACCOUNT REVIEW</p><h1>{user.firstName} {user.lastName}</h1><p>{user.email}</p></header>{error && <Notice kind="error">{error}</Notice>}{notice && <Notice kind="success">{notice} Restored accounts must log in again; revoked sessions are never revived.</Notice>}<div className="account-grid"><section className="panel"><h2>Current access</h2><div className="stat-line"><span>Status: <strong>{user.status}</strong></span><span>Revision: <strong>{user.revision}</strong></span><span>Capabilities: <strong>{user.capabilities.join(", ")}</strong></span></div><p>Restriction actions preserve existing bookings, funds, and history.</p>{options.length > 0 ? <form className="form" onSubmit={transition}><div className="field"><label htmlFor="action">Account action</label><select id="action" name="action" defaultValue=""><option value="" disabled>Choose an action</option>{options.map((o) => <option key={o} value={o}>{o === "SUSPEND" ? "Suspend access" : o === "BAN" ? "Permanently ban" : "Restore access"}</option>)}</select></div><Field id="reason" label="Reason (required)" maxLength={500} required error={reasonError}/><button className="button" disabled={pending}>{pending ? "Saving action…" : "Record action"}</button></form> : <Notice kind="info">Banned accounts are permanent for this delivery and cannot be restored.</Notice>}</section><section className="panel"><h2>Restriction history</h2>{detail.audit.length ? <ul className="audit-list">{detail.audit.map((entry) => <li key={entry.id}><strong>{entry.action}</strong><p>{entry.reason || "No reason recorded"}</p><time dateTime={entry.occurredAt}>{new Date(entry.occurredAt).toLocaleString()}</time></li>)}</ul> : <div className="empty-state">No restriction actions have been recorded.</div>}</section></div></>;
}
export default function AdminUserDetailPage({ params }: { params: Promise<{ userId: string }> }) { const { userId } = use(params); return <RequireAuth admin><UserDetail userId={userId}/></RequireAuth>; }
