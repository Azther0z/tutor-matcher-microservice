"use client";

import { useCallback, useEffect, useState } from "react";
import { Notice } from "@/components/field";
import { apiResponse, api, errorMessage, newIdempotencyKey } from "@/lib/api";
import { DemoBanner, Pager, StatusBadge } from "@/features/wallet/common";
import { formatTime, titleCase } from "@/features/wallet/format";
import type { Paged } from "@/features/wallet/types";
import { GROUPS, type Preferences, type PreferencesWrite, type Receipt } from "./types";

function PreferencesPanel() {
  const [saved, setSaved] = useState<Preferences | null>(null);
  const [draft, setDraft] = useState<PreferencesWrite | null>(null);
  const [etag, setEtag] = useState("");
  const [key, setKey] = useState(newIdempotencyKey());
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    setError("");
    try {
      const result = await apiResponse<Preferences>("/notifications/preferences");
      const { revision: _revision, ...writable } = result.data;
      void _revision;
      setSaved(result.data); setDraft(writable); setEtag(result.headers.get("ETag") ?? `"${result.data.revision}"`);
    } catch (e) { setError(errorMessage(e, "We couldn’t load your preferences.")); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  function toggle(group: keyof PreferencesWrite, channel: "email" | "push", value: boolean) {
    setDraft((current) => (current ? { ...current, [group]: { ...current[group], [channel]: value } } : current));
    setKey(newIdempotencyKey()); setNotice("");
  }

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft) return;
    setPending(true); setError(""); setNotice("");
    try {
      const result = await apiResponse<Preferences>("/notifications/preferences", { method: "PUT", body: draft, idempotencyKey: key, ifMatch: etag });
      const { revision: _revision, ...writable } = result.data;
      void _revision;
      setSaved(result.data); setDraft(writable); setEtag(result.headers.get("ETag") ?? `"${result.data.revision}"`); setKey(newIdempotencyKey());
      setNotice("Your notification preferences were saved.");
    } catch (e) {
      setError(errorMessage(e, "We couldn’t save your preferences."));
      if ((e as { status?: number }).status === 412) await load();
    } finally { setPending(false); }
  }

  return (
    <section className="panel" aria-labelledby="prefs-heading">
      <h2 id="prefs-heading">Preferences</h2>
      <p>Choose how you hear about each kind of event. Account and security messages (system email) are always sent.</p>
      {error && <Notice kind="error">{error}</Notice>}
      {notice && <Notice kind="success">{notice}</Notice>}
      {!draft && !error && <p role="status">Loading your preferences…</p>}
      {draft && saved && (
        <form className="form" onSubmit={save}>
          <div className="table-wrap">
            <table className="data-table">
              <thead><tr><th>Kind</th><th>Email</th><th>Push</th></tr></thead>
              <tbody>
                {GROUPS.map(({ key: group, label, hint }) => (
                  <tr key={group}>
                    <td><strong>{label}</strong><br /><span className="small-muted">{hint}</span></td>
                    <td><label className="check-row"><input type="checkbox" aria-label={`${label}: email`} checked={draft[group].email} onChange={(e) => toggle(group, "email", e.target.checked)} /></label></td>
                    <td><label className="check-row"><input type="checkbox" aria-label={`${label}: push`} checked={draft[group].push} onChange={(e) => toggle(group, "push", e.target.checked)} /></label></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button className="button" disabled={pending}>{pending ? "Saving…" : "Save preferences"}</button>
        </form>
      )}
    </section>
  );
}

function ReceiptsPanel() {
  const [result, setResult] = useState<Paged<Receipt> | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async (page = 1) => {
    setPending(true); setError("");
    try { setResult(await api<Paged<Receipt>>(`/notifications?page=${page}&pageSize=20`)); }
    catch (e) { setError(errorMessage(e, "We couldn’t load your notifications.")); }
    finally { setPending(false); }
  }, []);
  useEffect(() => { void load(1); }, [load]);

  return (
    <section className="panel" aria-labelledby="receipts-heading">
      <h2 id="receipts-heading">Delivery receipts</h2>
      <p>Each row is one simulated Email or Push delivery. Nothing is actually sent outside this demonstration.</p>
      {error && <Notice kind="error">{error} <button className="button button-quiet" onClick={() => void load(1)}>Try again</button></Notice>}
      {!result && !error && <p role="status">Loading…</p>}
      {result && result.items.length === 0 && <p className="empty-state">No notifications yet.</p>}
      {result && result.items.length > 0 && (
        <div className="table-wrap">
          <table className="data-table">
            <thead><tr><th>When</th><th>About</th><th>Channel</th><th>Status</th></tr></thead>
            <tbody>
              {result.items.map((receipt) => (
                <tr key={receipt.id}>
                  <td>{formatTime(receipt.createdAt)}</td>
                  <td>{titleCase(receipt.category)}</td>
                  <td>{titleCase(receipt.channel)} <span className="badge">Simulated</span></td>
                  <td><StatusBadge value={receipt.status} />{receipt.deliveredAt && <><br /><span className="small-muted">{formatTime(receipt.deliveredAt)}</span></>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {result && <Pager meta={result.pagination} onPage={(page) => void load(page)} disabled={pending} />}
    </section>
  );
}

export function NotificationsPage() {
  return (
    <>
      <header className="section-heading"><p className="eyebrow">NOTIFICATIONS</p><h1>Notifications</h1><p>Choose what you’re told about and review what was delivered.</p></header>
      <DemoBanner />
      <PreferencesPanel />
      <ReceiptsPanel />
    </>
  );
}
