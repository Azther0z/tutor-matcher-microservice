"use client";

import Link from "next/link";
import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ErrorNotice, Field, Notice, focusFirstInvalid } from "@/components/field";
import { ApiError, api, failureOf, fieldErrors, isValidEmail, safeReturnPath, type Failure } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import type { AuthSession } from "@/lib/types";

const NOTICES: Record<string, string> = {
  "password-changed": "Your password was changed and every session was signed out. Log in with your new password.",
  deactivated: "Your account was deactivated and you were signed out. An administrator can restore access.",
};

/** Where a fresh login lands when no page asked for it: admins go to their review queue, everyone else to tutor search. */
function homeFor(capabilities: string[]): string {
  return capabilities.includes("ADMIN") ? "/admin/tutor-requests" : "/discover";
}

function LoginForm() {
  const params = useSearchParams();
  const router = useRouter();
  const { accept, ready, account } = useAuth();
  const notice = NOTICES[params.get("notice") ?? ""];
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<Failure | null>(null);
  const [emailError, setEmailError] = useState("");
  const [passwordError, setPasswordError] = useState("");
  // Someone who is already signed in has no use for the form.
  useEffect(() => { if (ready && account) router.replace(safeReturnPath(params.get("returnTo"), homeFor(account.capabilities))); }, [ready, account, router, params]);
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setPending(true); setError(null); setEmailError(""); setPasswordError("");
    const formElement = event.currentTarget;
    const form = new FormData(event.currentTarget);
    const email = String(form.get("email") ?? "").trim();
    const password = String(form.get("password") ?? "");
    if (!email) setEmailError("Enter your email address.");
    else if (!isValidEmail(email)) setEmailError("Enter a valid email address.");
    if (!password) setPasswordError("Enter your password.");
    if (!email || !isValidEmail(email) || !password) { setPending(false); focusFirstInvalid(formElement); return; }
    try {
      const session = await api<AuthSession>("/auth/login", { method: "POST", auth: false, body: { email, password } });
      accept(session);
      router.replace(safeReturnPath(params.get("returnTo"), homeFor(session.user.capabilities)));
    } catch (e) {
      const failure = failureOf(e, "We couldn’t sign you in. Try again in a moment.");
      const code = e instanceof ApiError ? e.body?.code : undefined;
      const fields = fieldErrors(e);
      if (fields.email) setEmailError(fields.email);
      if (fields.password) setPasswordError(fields.password);
      if (code === "INVALID_CREDENTIALS") setError({ ...failure, message: "Email or password is incorrect." });
      else if (code === "ACCOUNT_RESTRICTED") setError({ ...failure, message: "This account is deactivated or restricted, so it can’t be used to log in. An administrator can restore access." });
      else setError(fields.email || fields.password ? null : failure);
      focusFirstInvalid(formElement);
    } finally { setPending(false); }
  }
  if (ready && account) return <p role="status">You’re already signed in. Opening your account…</p>;
  return <div className="form-layout form-layout-compact"><aside className="form-aside"><h1>Pick up where you left off.</h1><p>Sign in to manage your learning account and continue your journey.</p></aside><section className="form-card form-card-compact"><h2>Log in</h2><p>Use the email address linked to your account.</p>{notice && <Notice kind="success">{notice}</Notice>}<ErrorNotice failure={error}/><form className="form" onSubmit={submit} noValidate><Field id="email" label="Email address" type="email" autoComplete="email" required error={emailError}/><Field id="password" label="Password" type="password" autoComplete="current-password" required error={passwordError}/><div className="auth-forgot"><Link href="/password-reset">Forgot password?</Link></div><button className="button auth-submit" type="submit" disabled={pending}>{pending ? "Signing in…" : "Log in"}</button></form><p className="form-footer auth-footer">New here? <Link href="/signup">Create an account</Link></p></section></div>;
}

export default function LoginPage() { return <Suspense fallback={<p role="status">Loading sign in…</p>}><LoginForm /></Suspense>; }
