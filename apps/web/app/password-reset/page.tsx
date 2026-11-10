"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ErrorNotice, Field, Notice, focusFirstInvalid } from "@/components/field";
import { PASSWORD_MAX_LENGTH, api, failureOf, fieldErrors, isValidEmail, newIdempotencyKey, type Failure } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";

type Mode = "request" | "checking" | "confirm" | "sent" | "done" | "invalid";

export default function PasswordResetPage() {
  const { clearLocal } = useAuth();
  const [mode, setMode] = useState<Mode>("request"); const [token, setToken] = useState(""); const [confirmKey, setConfirmKey] = useState(newIdempotencyKey());
  const [pending, setPending] = useState(false); const [error, setError] = useState<Failure | null>(null); const [emailError, setEmailError] = useState(""); const [passwordError, setPasswordError] = useState(""); const [confirmationError, setConfirmationError] = useState("");
  useEffect(() => {
    // The emailed link can be opened in a tab that is already on this page, which only changes the hash.
    function readToken() {
      const fragment = window.location.hash.slice(1);
      if (!fragment) return;
      const values = new URLSearchParams(fragment);
      const resetToken = values.get("token") ?? "";
      window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
      if (!resetToken) { setMode("invalid"); return; }
      setToken(resetToken); setMode("checking");
      void api<{ valid: true; expiresAt: string }>("/auth/password-reset/validate", { method: "POST", auth: false, body: { token: resetToken } })
        .then(() => setMode("confirm"))
        .catch(() => { setToken(""); setMode("invalid"); });
    }
    readToken();
    window.addEventListener("hashchange", readToken);
    return () => window.removeEventListener("hashchange", readToken);
  }, []);
  async function requestReset(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setPending(true); setError(null); setEmailError("");
    const formElement = event.currentTarget;
    const email = String(new FormData(event.currentTarget).get("email") ?? "").trim();
    if (!email || !isValidEmail(email)) { setEmailError(email ? "Enter a valid email address." : "Enter your email address."); setPending(false); focusFirstInvalid(formElement); return; }
    try { await api("/auth/password-reset/request", { method: "POST", auth: false, body: { email } }); setMode("sent"); }
    catch (e) { const fields = fieldErrors(e); if (fields.email) { setEmailError(fields.email); focusFirstInvalid(formElement); } else setError(failureOf(e, "We couldn’t process the request. Try again shortly.")); }
    finally { setPending(false); }
  }
  async function confirmReset(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setPending(true); setError(null); setPasswordError(""); setConfirmationError("");
    const formElement = event.currentTarget;
    const form = new FormData(event.currentTarget); const password = String(form.get("password") ?? ""); const passwordConfirmation = String(form.get("passwordConfirmation") ?? "");
    const passwordProblem = password.length < 8 ? "Use at least 8 characters." : password.length > PASSWORD_MAX_LENGTH ? `Use ${PASSWORD_MAX_LENGTH} characters or fewer.` : "";
    if (passwordProblem) setPasswordError(passwordProblem);
    if (password !== passwordConfirmation) setConfirmationError("Passwords do not match.");
    if (passwordProblem || password !== passwordConfirmation) { setPending(false); focusFirstInvalid(formElement); return; }
    try { await api<void>("/auth/password-reset/confirm", { method: "POST", auth: false, idempotencyKey: confirmKey, body: { token, password, passwordConfirmation } }); clearLocal(); setConfirmKey(newIdempotencyKey()); setToken(""); setMode("done"); }
    catch (e) { setError(failureOf(e, "This reset link may have expired or already been used. Request a new one.")); }
    finally { setPending(false); }
  }
  return <div className="form-layout form-layout-compact"><aside className="form-aside"><h1>Get back to what matters.</h1><p>We’ll help you reset your password securely. Reset links can be used once and expire after 30 minutes.</p></aside><section className="form-card form-card-compact">
    {mode === "request" && <><h2>Reset your password</h2><p>Enter your email address and we’ll send a reset link if an account matches.</p><ErrorNotice failure={error}/><form className="form" onSubmit={requestReset} noValidate><Field id="email" label="Email address" type="email" autoComplete="email" required error={emailError}/><button className="button auth-submit" disabled={pending}>{pending ? "Sending…" : "Send reset link"}</button></form><p className="form-footer auth-footer"><Link href="/login">Return to log in</Link></p></>}
    {mode === "sent" && <><Notice kind="success">If an account matches, reset instructions are queued for simulated delivery.</Notice><h2>Reset request received</h2><p>Delivery is simulated for this course demo. For your privacy, this same message appears whether or not an account matches.</p><p className="form-footer auth-footer"><Link href="/login">Return to log in</Link></p></>}
    {mode === "checking" && <p role="status">Checking your reset link…</p>}
    {mode === "invalid" && <><Notice kind="error">This reset link is invalid, expired, or already used.</Notice><h2>Request a new link</h2><p>Start again with your email address.</p><button className="button" onClick={() => { setMode("request"); setError(null); }}>Request reset</button></>}
    {mode === "confirm" && <><h2>Choose a new password</h2><p>After you reset it, you’ll need to log in again on your devices.</p><ErrorNotice failure={error}/><form className="form" onSubmit={confirmReset} noValidate><Field id="password" label="New password" type="password" autoComplete="new-password" minLength={8} maxLength={PASSWORD_MAX_LENGTH} hint={`Use 8 to ${PASSWORD_MAX_LENGTH} characters.`} required error={passwordError}/><Field id="passwordConfirmation" label="Confirm new password" type="password" autoComplete="new-password" maxLength={PASSWORD_MAX_LENGTH} required error={confirmationError}/><div><button className="button" disabled={pending}>{pending ? "Updating…" : "Set new password"}</button></div></form></>}
    {mode === "done" && <><Notice kind="success">Your password has been changed and all existing sessions have been revoked.</Notice><h2>You’re all set</h2><p>Log in with your new password to continue.</p><Link className="button" href="/login">Go to log in</Link></>}
  </section></div>;
}
