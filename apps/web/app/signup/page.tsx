"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ErrorNotice, Field, focusFirstInvalid } from "@/components/field";
import { PASSWORD_MAX_LENGTH, api, failureOf, fieldErrors, isValidEmail, newIdempotencyKey, type Failure } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import type { AuthSession } from "@/lib/types";

export default function SignupPage() {
  const { accept, ready, account } = useAuth(); const router = useRouter();
  const [pending, setPending] = useState(false); const [error, setError] = useState<Failure | null>(null); const [errors, setErrors] = useState<Record<string, string>>({}); const [signupKey, setSignupKey] = useState(newIdempotencyKey());
  useEffect(() => { if (ready && account) router.replace("/account"); }, [ready, account, router]);
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setPending(true); setError(null); setErrors({});
    const formElement = event.currentTarget;
    const form = new FormData(event.currentTarget);
    const firstName = String(form.get("firstName") ?? "").trim(); const lastName = String(form.get("lastName") ?? "").trim();
    const email = String(form.get("email") ?? "").trim(); const password = String(form.get("password") ?? ""); const passwordConfirmation = String(form.get("passwordConfirmation") ?? "");
    const adminSignupKey = String(form.get("adminSignupKey") ?? "");
    const clientErrors: Record<string, string> = {};
    if (!firstName) clientErrors.firstName = "Enter your first name.";
    if (!lastName) clientErrors.lastName = "Enter your last name.";
    if (!email) clientErrors.email = "Enter your email address.";
    else if (!isValidEmail(email)) clientErrors.email = "Enter a valid email address.";
    if (password.length < 8) clientErrors.password = "Use at least 8 characters.";
    else if (password.length > PASSWORD_MAX_LENGTH) clientErrors.password = `Use ${PASSWORD_MAX_LENGTH} characters or fewer.`;
    if (password !== passwordConfirmation) clientErrors.passwordConfirmation = "Passwords do not match.";
    if (!form.has("termsAccepted")) clientErrors.termsAccepted = "Accept the Terms to continue.";
    if (!form.has("privacyAccepted")) clientErrors.privacyAccepted = "Accept the Privacy notice to continue.";
    if (Object.keys(clientErrors).length) { setErrors(clientErrors); setPending(false); focusFirstInvalid(formElement); return; }
    const body: Record<string, unknown> = { firstName, lastName, email, password, passwordConfirmation, termsAccepted: true, privacyAccepted: true };
    if (adminSignupKey) body.adminSignupKey = adminSignupKey;
    try {
      const session = await api<AuthSession>("/auth/signup", { method: "POST", auth: false, idempotencyKey: signupKey, body });
      accept(session); setSignupKey(newIdempotencyKey()); router.replace("/account");
    } catch (e) {
      const fields = fieldErrors(e); const failure = failureOf(e, "We couldn’t create your account. Try again.");
      setErrors(fields);
      // A message that already sits under its field (for example a duplicate email) is not repeated in the banner.
      setError(Object.values(fields).includes(failure.message) ? null : failure);
      focusFirstInvalid(formElement);
    }
    finally { setPending(false); }
  }
  return <div className="form-layout"><aside className="form-aside"><p className="eyebrow">START WITH A SMALL STEP</p><h1>Make room for a little more progress.</h1><p>Set up your account and make learning feel more yours. Every new account begins with Student access.</p></aside><section className="form-card"><h2>Create your account</h2><p>It only takes a minute to get started.</p><ErrorNotice failure={error}/><form className="form" onSubmit={submit} noValidate><div className="field-set"><Field id="firstName" label="First name" autoComplete="given-name" required error={errors.firstName}/><Field id="lastName" label="Last name" autoComplete="family-name" required error={errors.lastName}/></div><Field id="email" label="Email address" type="email" autoComplete="email" required error={errors.email}/><Field id="password" label="Password" type="password" autoComplete="new-password" minLength={8} maxLength={PASSWORD_MAX_LENGTH} hint={`Use 8 to ${PASSWORD_MAX_LENGTH} characters.`} required error={errors.password}/><Field id="passwordConfirmation" label="Confirm password" type="password" autoComplete="new-password" minLength={8} maxLength={PASSWORD_MAX_LENGTH} required error={errors.passwordConfirmation}/><Field id="adminSignupKey" label="Admin signup key (optional)" type="password" autoComplete="off" error={errors.adminSignupKey}/><label className="check-row"><input name="termsAccepted" type="checkbox" required aria-invalid={Boolean(errors.termsAccepted)}/><span>I agree to the Terms of Service. {errors.termsAccepted && <span className="field-error">{errors.termsAccepted}</span>}</span></label><label className="check-row"><input name="privacyAccepted" type="checkbox" required aria-invalid={Boolean(errors.privacyAccepted)}/><span>I have read the Privacy notice. {errors.privacyAccepted && <span className="field-error">{errors.privacyAccepted}</span>}</span></label><div><button className="button" type="submit" disabled={pending}>{pending ? "Creating account…" : "Create account"}</button></div></form><p className="form-footer">Already have an account? <Link href="/login">Log in</Link></p></section></div>;
}
