"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { ErrorNotice, Field, Notice } from "@/components/field";
import { api, failureOf, fieldErrors, newIdempotencyKey, type Failure } from "@/lib/api";
import { formatMoney, formatTime, normalizeAmount } from "./format";
import type { Topup } from "./types";

const PROMPTPAY_ID = "0000000000";
const MAX_SLIP_BYTES = 2 * 1024 * 1024;
const SLIP_TYPES = ["image/png", "image/jpeg", "image/webp"];

/** Reads a File as base64 (without the data: prefix). */
function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(new Error("The file could not be read."));
    reader.readAsDataURL(file);
  });
}

/**
 * Add funds by PromptPay: enter an amount, scan the QR to transfer, attach the slip and send the request. An admin approves
 * or rejects it; only one request can wait for review at a time.
 */
export function TopupRequestPanel({ returnTo, unavailable }: { returnTo: string | null; unavailable: boolean }) {
  const [amount, setAmount] = useState("");
  const [slip, setSlip] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [key, setKey] = useState(newIdempotencyKey());
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<Failure | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [latest, setLatest] = useState<Topup | null>(null);
  const [loaded, setLoaded] = useState(false);
  const inFlight = useRef(false);

  const loadLatest = useCallback(async () => {
    try {
      const page = await api<{ items: Topup[] }>("/wallet/topups?pageSize=5");
      setLatest(page.items.find((item) => item.manual) ?? null);
    } catch {
      setLatest(null);
    } finally {
      setLoaded(true);
    }
  }, []);
  useEffect(() => { void loadLatest(); }, [loadLatest]);
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);

  const normalized = normalizeAmount(amount);
  const waiting = latest?.status === "PENDING";

  function chooseSlip(file: File | undefined) {
    setFields((current) => ({ ...current, slip: "" }));
    if (preview) URL.revokeObjectURL(preview);
    if (!file) { setSlip(null); setPreview(null); return; }
    if (!SLIP_TYPES.includes(file.type)) { setSlip(null); setPreview(null); setFields((c) => ({ ...c, slip: "Choose a PNG, JPEG or WebP image." })); return; }
    if (file.size > MAX_SLIP_BYTES) { setSlip(null); setPreview(null); setFields((c) => ({ ...c, slip: "The slip image must be 2 MB or smaller." })); return; }
    setSlip(file);
    setPreview(URL.createObjectURL(file));
    setKey(newIdempotencyKey());
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current || unavailable || waiting) return;
    setError(null);
    const problems: Record<string, string> = {};
    if (!normalized) problems.amount = "Enter an amount from 0.01 to 100,000.00 with at most two decimal places.";
    if (!slip) problems.slip = "Attach the transfer slip image.";
    setFields(problems);
    if (Object.keys(problems).length) return;
    inFlight.current = true;
    setPending(true);
    try {
      const slipImage = await toBase64(slip as File);
      const created = await api<Topup>("/wallet/topups", {
        method: "POST", idempotencyKey: key,
        body: { amount: normalized, slipImage, slipContentType: (slip as File).type, ...(returnTo ? { returnToBookingId: returnTo } : {}) },
      });
      setLatest(created);
      setAmount(""); setSlip(null); setPreview(null); setKey(newIdempotencyKey());
    } catch (e) {
      setFields(fieldErrors(e));
      setError(failureOf(e, "We couldn’t send the request. Your balance has not changed."));
      void loadLatest();
    } finally { inFlight.current = false; setPending(false); }
  }

  return (
    <section className="panel" aria-labelledby="topup-heading">
      <h2 id="topup-heading">Add funds with PromptPay</h2>
      {returnTo && <Notice kind="info">After an admin approves your top-up you can return to your booking.</Notice>}
      {unavailable && <Notice kind="info">Adding funds is unavailable until your wallet loads.</Notice>}
      {loaded && latest?.status === "FAILED" && (
        <Notice kind="error">Your last top-up of {formatMoney(latest.amount)} was rejected{latest.decisionReason ? `: ${latest.decisionReason}` : "."} You can send a new request below.</Notice>
      )}
      {loaded && latest?.status === "SUCCEEDED" && (
        <Notice kind="success">Your last top-up of {formatMoney(latest.amount)} was approved and added to your balance.</Notice>
      )}
      {waiting && latest ? (
        <div className="notice notice-info" role="status">
          <strong>Your request is waiting for an admin.</strong>
          <p>{formatMoney(latest.amount)} sent {formatTime(latest.createdAt)}. You can send another request after it is approved or rejected.</p>
          <Link className="text-link" href={`/wallet/topups/${latest.id}${returnTo ? `?returnToBookingId=${returnTo}` : ""}`}>View request</Link>
        </div>
      ) : (
        <>
          <p>Enter the amount, scan the QR code with your banking app to transfer it, then attach your transfer slip and send the request. Your balance is credited when an admin approves it.</p>
          <ErrorNotice failure={error} />
          <form className="form" onSubmit={submit} noValidate aria-busy={pending}>
            <Field id="amount" label="Amount (THB)" inputMode="decimal" autoComplete="off" placeholder="e.g. 500.00" value={amount}
              error={fields.amount ?? fields.amount_amount} disabled={unavailable || pending}
              onChange={(e) => { setAmount(e.target.value); setKey(newIdempotencyKey()); }} />
            {normalized && (
              <figure className="promptpay-qr">
                <img src={`https://promptpay.io/${PROMPTPAY_ID}/${normalized}.png`} alt={`PromptPay QR code for THB ${normalized}`} width={240} height={240} />
                <figcaption>Scan to transfer <strong>THB {normalized}</strong></figcaption>
              </figure>
            )}
            <div className="field">
              <label htmlFor="slip">Transfer slip</label>
              <input id="slip" name="slip" type="file" accept="image/png,image/jpeg,image/webp" disabled={unavailable || pending}
                onChange={(e) => chooseSlip(e.target.files?.[0])} aria-invalid={Boolean(fields.slip)} />
              <span className="field-hint">PNG, JPEG or WebP, up to 2 MB.</span>
              {fields.slip && <span className="field-error">{fields.slip}</span>}
              {preview && (
                <img className="slip-preview" src={preview} alt="Selected transfer slip" />
              )}
            </div>
            <button className="button" disabled={pending || unavailable || !loaded}>{pending ? "Sending…" : "Send top-up request"}</button>
          </form>
        </>
      )}
    </section>
  );
}
