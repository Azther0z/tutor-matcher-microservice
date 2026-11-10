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
  return (
    <>
      <header className="page-heading"><h1>Password reset delivery</h1></header>
      <section className="panel booking-new">
        <p className="tutor-card-meta">Look up synthetic reset content by reference. Demo content is short-lived and sensitive, so use synthetic fixtures only.</p>
        {error && <Notice kind="error">{error}</Notice>}
        <form className="form" onSubmit={submit}>
          <Field id="contentRef" label="Content reference" autoComplete="off" required placeholder="content reference" />
          <button className="button" disabled={pending}>{pending ? "Loading…" : "Inspect content"}</button>
        </form>
        {content && (
          <>
            <div className="summary-rows">
              <div><span>Recipient</span><strong className="mono-id">{content.recipientUserId}</strong></div>
              <div><span>Expires</span><strong>{new Date(content.expiresAt).toLocaleString()}</strong></div>
            </div>
            <h3 className="list-title" style={{ margin: 0 }}>{content.subject}</h3>
            <div className="sensitive-box">{content.text}</div>
          </>
        )}
      </section>
    </>
  );
}
export default function DemoPasswordResetsPage() { return <RequireAuth admin><ResetContentLookup/></RequireAuth>; }
