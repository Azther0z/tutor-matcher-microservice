"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { ErrorNotice, Field, Notice } from "@/components/field";
import { LegalModal } from "@/components/legal-modal";
import { ProgressStepper } from "@/components/progress-stepper";
import { StatusBadge } from "./common";
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
export function TopupRequestPanel({ returnTo, unavailable, open, onClose, onWaiting }: { returnTo: string | null; unavailable: boolean; open: boolean; onClose: () => void; onWaiting?: (waiting: boolean) => void }) {
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
  const fileRef = useRef<HTMLInputElement>(null);
  const [confirmed, setConfirmed] = useState<string | null>(null);

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
  useEffect(() => { onWaiting?.(waiting); }, [waiting, onWaiting]);

  function confirmAmount(event?: React.FormEvent) {
    event?.preventDefault();
    if (!normalized) {
      setFields({ amount: "Enter an amount from 0.01 to 100,000.00 with at most two decimal places." });
      return;
    }
    setFields({});
    setConfirmed(normalized);
    setKey(newIdempotencyKey());
  }
  function changeAmount() {
    setConfirmed(null);
    setSlip(null);
    if (preview) URL.revokeObjectURL(preview);
    setPreview(null);
    setFields({});
    if (fileRef.current) fileRef.current.value = "";
  }

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
    if (!confirmed) problems.amount = "Confirm the amount first.";
    if (!slip) problems.slip = "Attach the transfer slip image.";
    setFields(problems);
    if (Object.keys(problems).length) return;
    inFlight.current = true;
    setPending(true);
    try {
      const slipImage = await toBase64(slip as File);
      const created = await api<Topup>("/wallet/topups", {
        method: "POST", idempotencyKey: key,
        body: { amount: confirmed, slipImage, slipContentType: (slip as File).type, ...(returnTo ? { returnToBookingId: returnTo } : {}) },
      });
      setLatest(created);
      setAmount(""); setConfirmed(null); setSlip(null); setPreview(null); setKey(newIdempotencyKey());
      onClose();
    } catch (e) {
      setFields(fieldErrors(e));
      setError(failureOf(e, "We couldn’t send the request. Your balance has not changed."));
      void loadLatest();
    } finally { inFlight.current = false; setPending(false); }
  }

  return (
    <>
      {returnTo && <Notice kind="info">After an admin approves your top-up you can return to your booking.</Notice>}
      {unavailable && <Notice kind="info">Adding funds is unavailable until your wallet loads.</Notice>}
      {loaded && latest && (
        <section className="panel booking-new topup-card" aria-label="Latest top-up request">
          <StatusBadge value={latest.status === "SUCCEEDED" ? "APPROVED" : latest.status === "FAILED" ? "REJECTED" : "PENDING"} corner />
          <div className="booking-title">
            <h2>Top-up request, {formatMoney(latest.amount)}</h2>
            <p className="tutor-card-meta">Sent {formatTime(latest.createdAt)}</p>
          </div>
          <ProgressStepper
            steps={["Submitted", "Admin review", "Credited"]}
            reached={latest.status === "SUCCEEDED" ? 2 : 0}
            failed={latest.status === "FAILED"}
            label="Top-up rejected"
          />
          {latest.status === "FAILED" && latest.decisionReason && (
            <div className="summary-rows">
              <div>
                <span>Reason</span>
                <strong className="summary-note">{latest.decisionReason}</strong>
              </div>
            </div>
          )}
          <div className="slot-footer flush">
            <span className="tutor-card-meta">
              {waiting
                ? "You can send another top-up request after this one is approved or rejected."
                : "You can send a new top-up request any time."}
            </span>
            <Link className="button button-quiet" href={`/wallet/topups/${latest.id}${returnTo ? `?returnToBookingId=${returnTo}` : ""}`}>
              View request
            </Link>
          </div>
        </section>
      )}
      <LegalModal
        open={open && !waiting}
        title={confirmed ? "Transfer and attach slip" : "Add funds"}
        onClose={onClose}
        actions={
          <div className="button-row" style={{ justifyContent: "flex-end" }}>
            {!confirmed ? (
              <>
                <button type="button" className="button button-quiet" onClick={onClose}>Cancel</button>
                <button type="submit" form="topup-amount-form" className="button" disabled={unavailable || !loaded || !normalized}>Confirm amount</button>
              </>
            ) : (
              <>
                <button type="button" className="button button-quiet" onClick={changeAmount} disabled={pending}>Change amount</button>
                <button type="submit" form="topup-send-form" className="button" disabled={pending || unavailable || !loaded || !slip}>{pending ? "Sending…" : "Send request"}</button>
              </>
            )}
          </div>
        }
      >
        <div className="topup-body">
          <ErrorNotice failure={error} />
          {!confirmed ? (
            <form id="topup-amount-form" className="topup-step" onSubmit={confirmAmount} noValidate>
              <Field id="amount" label="How much do you want to add? (THB)" inputMode="decimal" autoComplete="off" placeholder="500.00" value={amount}
                error={fields.amount ?? fields.amount_amount} disabled={unavailable}
                onChange={(e) => { setAmount(e.target.value); setFields({}); }} />
              <div className="topup-quick" role="group" aria-label="Quick amounts">
                {["100", "300", "500", "1000"].map((value) => (
                  <button type="button" key={value} className="topup-chip" onClick={() => { setAmount(value); setFields({}); }}>
                    {Number(value).toLocaleString("en-US")}
                  </button>
                ))}
              </div>
              <p className="tutor-card-meta">Your balance is credited when an admin approves the request.</p>
            </form>
          ) : (
            <form id="topup-send-form" className="topup-send" onSubmit={submit} noValidate aria-busy={pending}>
              <figure className="promptpay-qr">
                <img src={`https://promptpay.io/${PROMPTPAY_ID}/${confirmed}.png`} alt={`PromptPay QR code for THB ${confirmed}`} width={200} height={200} />
                <figcaption>Scan to transfer <strong>THB {confirmed}</strong></figcaption>
              </figure>
              <div className="field">
                <span className="field-label">Transfer slip</span>
                <input ref={fileRef} id="slip" name="slip" type="file" hidden accept="image/png,image/jpeg,image/webp" disabled={unavailable || pending}
                  onChange={(e) => chooseSlip(e.target.files?.[0])} aria-label="Transfer slip" />
                <div className="slip-pick">
                  <button type="button" className="button button-quiet" disabled={unavailable || pending} onClick={() => fileRef.current?.click()}>
                    {slip ? "Change file" : "Choose file"}
                  </button>
                  <span className="small-muted">{slip ? slip.name : "PNG, JPEG or WebP, up to 2 MB"}</span>
                </div>
                {fields.slip && <span className="field-error">{fields.slip}</span>}
                {preview && (
                  <img className="slip-preview" src={preview} alt="Selected transfer slip" />
                )}
              </div>
            </form>
          )}
        </div>
      </LegalModal>
    </>
  );
}
