"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Field, Notice } from "@/components/field";
import { RequireAuth, useAuth } from "@/lib/auth-context";
import { api, apiResponse, errorMessage, fieldErrors, newIdempotencyKey } from "@/lib/api";
import type { Account, StudentProfile } from "@/lib/types";

function StudentLearningProfile() {
  const [profile, setProfile] = useState<StudentProfile | null>(null); const [etag, setEtag] = useState(""); const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false); const [error, setError] = useState(""); const [notice, setNotice] = useState(""); const [key, setKey] = useState(newIdempotencyKey());
  const load = useCallback(async () => {
    setLoading(true); setError("");
    try { const result = await apiResponse<StudentProfile>("/profiles/me/student"); setProfile(result.data); setEtag(result.headers.get("ETag") ?? `"${result.data.revision}"`); }
    catch (e) { setError(errorMessage(e, "Could not load your learning profile.")); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setPending(true); setError(""); setNotice("");
    const form = new FormData(event.currentTarget);
    const rawAreas = String(form.get("learningAreas") ?? "").split(",").map((value) => value.trim().toLowerCase()).filter(Boolean);
    const learningAreas = [...new Set(rawAreas)]; const level = String(form.get("level") ?? "").trim(); const goals = String(form.get("goals") ?? "").trim();
    const preferredPeriods = form.getAll("preferredPeriods").map(String);
    if (learningAreas.length > 30 || learningAreas.some((area) => !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(area))) { setError("Use up to 30 learning area tags with lowercase letters, numbers, and hyphens."); setPending(false); return; }
    try {
      const result = await apiResponse<StudentProfile>("/profiles/me/student", { method: "PUT", body: { learningAreas, level, goals, preferredPeriods }, idempotencyKey: key, ifMatch: etag });
      setProfile(result.data); setEtag(result.headers.get("ETag") ?? `"${result.data.revision}"`); setKey(newIdempotencyKey()); setNotice("Your learning profile has been saved.");
    } catch (e) { setError(errorMessage(e, "Could not save your learning profile.")); if ((e as { status?: number }).status === 412) void load(); }
    finally { setPending(false); }
  }
  if (loading) return <section className="panel"><h2>Student learning profile</h2><p role="status">Loading your learning preferences…</p></section>;
  if (!profile) return <section className="panel"><h2>Student learning profile</h2>{error && <Notice kind="error">{error}</Notice>}<button className="button button-quiet" onClick={() => void load()}>Try again</button></section>;
  return <section className="panel"><h2>Student learning profile</h2><p>Tell tutors what you want to learn and when you prefer lessons. Use lowercase tags such as <strong>algebra</strong> or <strong>web-development</strong>.</p>{error && <Notice kind="error">{error}</Notice>}{notice && <Notice kind="success">{notice}</Notice>}<form className="form" onSubmit={submit}><Field id="learningAreas" label="Learning areas (comma-separated)" defaultValue={profile.learningAreas.join(", ")} placeholder="algebra, web-development"/><Field id="level" label="Current level" maxLength={100} defaultValue={profile.level} placeholder="e.g. Beginner"/><div className="field"><label htmlFor="goals">Learning goals</label><textarea id="goals" name="goals" rows={4} maxLength={2000} defaultValue={profile.goals} placeholder="What would you like to achieve?"/></div><fieldset className="field"><legend>Preferred lesson periods</legend>{(["MORNING", "AFTERNOON", "EVENING"] as const).map((period) => <label className="check-row" key={period}><input name="preferredPeriods" type="checkbox" value={period} defaultChecked={profile.preferredPeriods.includes(period)}/><span>{period[0] + period.slice(1).toLowerCase()}</span></label>)}</fieldset><button className="button" disabled={pending}>{pending ? "Saving…" : "Save learning profile"}</button></form></section>;
}

function AccountSettings() {
  const { account, refresh, signOut, clearLocal } = useAuth(); const router = useRouter();
  const [settings, setSettings] = useState<Account | null>(null); const [etag, setEtag] = useState(""); const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false); const [notice, setNotice] = useState(""); const [error, setError] = useState(""); const [errors, setErrors] = useState<Record<string,string>>({});
  const [profileKey, setProfileKey] = useState(newIdempotencyKey()); const [passwordKey, setPasswordKey] = useState(newIdempotencyKey()); const [deactivateKey, setDeactivateKey] = useState(newIdempotencyKey());
  const load = useCallback(async () => {
    setLoading(true); setError("");
    try { const result = await apiResponse<Account>("/profiles/me/account"); setSettings(result.data); setEtag(result.headers.get("ETag") ?? `"${result.data.revision}"`); }
    catch (e) { setError(errorMessage(e, "We couldn’t load your account settings.")); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  async function updateProfile(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setPending(true); setError(""); setNotice(""); setErrors({});
    const f = new FormData(event.currentTarget); const body: Record<string,string> = { firstName: String(f.get("firstName") ?? "").trim(), lastName: String(f.get("lastName") ?? "").trim() };
    const email = String(f.get("email") ?? "").trim(); const currentPassword = String(f.get("emailCurrentPassword") ?? "");
    if (email !== settings?.email) { body.email = email; if (currentPassword) body.currentPassword = currentPassword; }
    if (!body.firstName || !body.lastName || (body.email !== undefined && !body.email)) { setErrors({ firstName: body.firstName ? "" : "Enter your first name.", lastName: body.lastName ? "" : "Enter your last name.", email: body.email ? "" : "Enter your email address." }); setPending(false); return; }
    try {
      const result = await apiResponse<Account>("/profiles/me/account", { method: "PUT", body, idempotencyKey: profileKey, ifMatch: etag });
      setSettings(result.data); setEtag(result.headers.get("ETag") ?? `"${result.data.revision}"`); setProfileKey(newIdempotencyKey()); setNotice("Your account details have been saved."); await refresh();
    } catch (e) { setErrors(fieldErrors(e)); setError(errorMessage(e, "Could not save your account details.")); if ((e as { status?: number }).status === 412) void load(); }
    finally { setPending(false); }
  }
  async function changePassword(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setPending(true); setError(""); setNotice(""); setErrors({});
    const f = new FormData(event.currentTarget); const currentPassword = String(f.get("passwordCurrentPassword") ?? ""); const newPassword = String(f.get("newPassword") ?? ""); const confirmation = String(f.get("passwordConfirmation") ?? "");
    if (newPassword.length < 8 || newPassword !== confirmation) { setErrors({ newPassword: newPassword.length < 8 ? "Use at least 8 characters." : "", passwordConfirmation: newPassword !== confirmation ? "Passwords do not match." : "" }); setPending(false); return; }
    try {
      await api<Account>("/profiles/me/account", { method: "PUT", body: { currentPassword, newPassword }, idempotencyKey: passwordKey, ifMatch: etag });
      setPasswordKey(newIdempotencyKey()); clearLocal(); window.location.replace("/login?notice=password-changed");
    } catch (e) { setErrors(fieldErrors(e)); setError(errorMessage(e, "Could not update your password.")); if ((e as { status?: number }).status === 412) void load(); }
    finally { setPending(false); }
  }
  async function deactivate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!window.confirm("Deactivate your account? Your email, bookings, funds, and history remain preserved. You’ll be signed out.") ) return;
    setPending(true); setError(""); setNotice("");
    const currentPassword = String(new FormData(event.currentTarget).get("deactivatePassword") ?? "");
    try {
      await api<Account>("/profiles/me/account", { method: "PUT", body: { currentPassword, deactivate: true }, idempotencyKey: deactivateKey, ifMatch: etag });
      setDeactivateKey(newIdempotencyKey()); clearLocal(); window.location.replace("/login?notice=deactivated");
    } catch (e) { setError(errorMessage(e, "Could not deactivate your account.")); if ((e as { status?: number }).status === 412) void load(); }
    finally { setPending(false); }
  }
  if (loading) return <p role="status">Loading account settings…</p>;
  if (!settings) return <><Notice kind="error">{error || "Account settings are unavailable."}</Notice><button className="button" onClick={() => void load()}>Try again</button></>;
  return <><header className="section-heading"><p className="eyebrow">YOUR PROFILE</p><h1>Account settings</h1><p>Manage your identity and security. Your access is controlled by your current account capabilities.</p></header>{error && <Notice kind="error">{error}</Notice>}{notice && <Notice kind="success">{notice}</Notice>}<div className="account-grid"><section className="panel"><h2>Personal details</h2><p>Changes to your name and email keep your current session active.</p><form className="form" onSubmit={updateProfile} noValidate><Field id="firstName" label="First name" defaultValue={settings.firstName} required error={errors.firstName}/><Field id="lastName" label="Last name" defaultValue={settings.lastName} required error={errors.lastName}/><Field id="email" label="Email address" type="email" defaultValue={settings.email} required error={errors.email}/><Field id="emailCurrentPassword" label="Current password (required to change email)" type="password" autoComplete="current-password" error={errors.currentPassword}/><button className="button" disabled={pending}>{pending ? "Saving…" : "Save details"}</button></form></section><section className="panel"><h2>Change password</h2><p>Changing your password signs out every session, including this one.</p><form className="form" onSubmit={changePassword} noValidate><Field id="passwordCurrentPassword" label="Current password" type="password" autoComplete="current-password" required error={errors.currentPassword}/><Field id="newPassword" label="New password" type="password" autoComplete="new-password" minLength={8} required error={errors.newPassword}/><Field id="passwordConfirmation" label="Confirm new password" type="password" autoComplete="new-password" required error={errors.passwordConfirmation}/><button className="button" disabled={pending}>{pending ? "Updating…" : "Update password"}</button></form></section></div><section className="panel"><h2>Sign out</h2><p>Sign out of this browser. To revoke all your sessions, change your password above.</p><button className="button button-quiet" onClick={() => { void signOut().finally(() => router.replace("/login")); }} disabled={pending}>Sign out of this session</button></section><section className="panel danger-panel"><h2>Deactivate account</h2><p>Deactivation signs you out and revokes every session. Your identity, reserved email, bookings, funds, and history remain preserved. Only an active admin can restore access.</p><form className="inline-form" onSubmit={deactivate}><Field id="deactivatePassword" label="Current password to deactivate" type="password" autoComplete="current-password" required error={errors.currentPassword}/><button className="button button-danger" disabled={pending}>{pending ? "Deactivating…" : "Deactivate account"}</button></form></section><StudentLearningProfile/><section className="panel"><h2>Account access</h2><div className="stat-line"><span>Access: <strong>{account?.capabilities.join(", ")}</strong></span><span>Status: <strong>{account?.status}</strong></span></div><p>New accounts always include Student capability. Additional capabilities are assigned through controlled review.</p><Link className="text-link" href="/">Browse Tutor Matcher</Link></section></>;
}

export default function AccountPage() { return <RequireAuth><AccountSettings/></RequireAuth>; }
