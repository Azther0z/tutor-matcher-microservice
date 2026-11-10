"use client";

import { useState } from "react";
import { Field, Notice } from "@/components/field";
import { RequireAuth } from "@/lib/auth-context";
import { api, errorMessage } from "@/lib/api";
import type { NotificationContent } from "@/lib/types";

function ResetContentLookup() {
  const [pending, setPending] = useState(false); const [error, setError] = useState(""); const [content, setContent] = useState<NotificationContent | null>(null);
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setPending(true); setError(""); setContent(null);
    const ref = String(new FormData(event.currentTarget).get("contentRef") ?? "").trim();
    if (!ref) { setError("Enter a synthetic reset content reference."); setPending(false); return; }
    try { const result = await api<NotificationContent>(`/demo/password-resets/${encodeURIComponent(ref)}`); if (result.sensitive !== true) throw new Error("The returned content is not marked sensitive."); setContent(result); }
    catch (e) { setError(errorMessage(e, "Could not load synthetic reset content.")); }
    finally { setPending(false); }
  }
  return <><header className="section-heading"><p className="eyebrow">DEMO ONLY · ADMIN</p><h1>Password reset delivery</h1><p>Inspect synthetic delivery content by reference. This page does not accept actual recipient data.</p></header><section className="panel"><Notice kind="info">Demo content is short-lived and sensitive. Use synthetic fixtures only. The service checks ADMIN access; the page does not grant it.</Notice>{error && <Notice kind="error">{error}</Notice>}<form className="inline-form" onSubmit={submit}><Field id="contentRef" label="Synthetic content reference" autoComplete="off" required placeholder="content reference"/><button className="button" disabled={pending}>{pending ? "Loading…" : "Inspect content"}</button></form>{content && <div style={{ marginTop: 24 }}><div className="stat-line"><span>Recipient ID: <strong>{content.recipientUserId}</strong></span><span>Expires: <strong>{new Date(content.expiresAt).toLocaleString()}</strong></span></div><h2 style={{ marginTop: 18 }}>{content.subject}</h2><div className="sensitive-box">{content.text}</div><p className="form-footer">Sensitive content is shown only on this admin demo page. Do not copy it into logs, tickets, or screenshots.</p></div>}</section></>;
}
export default function DemoPasswordResetsPage() { return <RequireAuth admin><ResetContentLookup/></RequireAuth>; }
