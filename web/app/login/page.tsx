"use client";

import Link from "next/link";
import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Field, Notice } from "@/components/field";
import { ApiError, api, errorMessage, safeReturnPath } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import type { AuthSession } from "@/lib/types";

function LoginForm() {
  const params = useSearchParams();
  const router = useRouter();
  const { accept } = useAuth();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [emailError, setEmailError] = useState("");
  const [passwordError, setPasswordError] = useState("");
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setPending(true); setError(""); setEmailError(""); setPasswordError("");
    const form = new FormData(event.currentTarget);
    const email = String(form.get("email") ?? "").trim();
    const password = String(form.get("password") ?? "");
    if (!email) setEmailError("Enter your email address.");
    if (!password) setPasswordError("Enter your password.");
    if (!email || !password) { setPending(false); return; }
    try {
      const session = await api<AuthSession>("/auth/login", { method: "POST", auth: false, body: { email, password } });
      accept(session);
      router.replace(safeReturnPath(params.get("returnTo")));
    } catch (e) {
      if (e instanceof ApiError && e.body?.code === "INVALID_CREDENTIALS") setError("Email or password is incorrect.");
      else if (e instanceof ApiError && e.body?.code === "ACCOUNT_RESTRICTED") setError("This account is currently restricted. Contact support if you need help.");
      else setError(errorMessage(e, "We couldn’t sign you in. Try again in a moment."));
    } finally { setPending(false); }
  }
  return <div className="form-layout"><aside className="form-aside"><p className="eyebrow">WELCOME BACK</p><h1>Pick up where you left off.</h1><p>Sign in to manage your learning account and continue your journey.</p></aside><section className="form-card"><h2>Log in</h2><p>Use the email address linked to your account.</p>{error && <Notice kind="error">{error}</Notice>}<form className="form" onSubmit={submit} noValidate><Field id="email" label="Email address" type="email" autoComplete="email" required error={emailError}/><Field id="password" label="Password" type="password" autoComplete="current-password" required error={passwordError}/><div><button className="button" type="submit" disabled={pending}>{pending ? "Signing in…" : "Log in"}</button></div></form><p className="form-footer"><Link href="/password-reset">Forgot your password?</Link> · New here? <Link href="/signup">Create an account</Link></p></section></div>;
}

export default function LoginPage() { return <Suspense fallback={<p role="status">Loading sign in…</p>}><LoginForm /></Suspense>; }
