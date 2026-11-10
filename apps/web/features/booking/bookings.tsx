"use client";

import Link from "next/link";
import { use, useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Field, Notice } from "@/components/field";
import { LegalModal } from "@/components/legal-modal";
import { Pager, StatusBadge } from "@/features/wallet/common";
import { formatMoney, formatTime } from "@/features/wallet/format";
import { ActionMessages, useAction } from "@/features/tutor/common";
import { RequireAuth, useAuth } from "@/lib/auth-context";
import {
  api,
  apiResponse,
  errorMessage,
  isUuid,
} from "@/lib/api";
import type { SubjectPageData } from "@/features/tutor/types";
import type { Booking, BookingPage, CancellationQuote } from "./types";

/** Live countdown to the end of the 15-minute payment hold. Reloads the booking when it reaches zero. */
function HoldCountdown({ expiresAt, onExpired }: { expiresAt: string; onExpired: () => void }) {
  const [left, setLeft] = useState(() => new Date(expiresAt).getTime() - Date.now());
  useEffect(() => {
    const timer = setInterval(() => setLeft(new Date(expiresAt).getTime() - Date.now()), 1000);
    return () => clearInterval(timer);
  }, [expiresAt]);
  useEffect(() => {
    if (left <= 0) onExpired();
    // Fire once when the hold ends; the reloaded booking no longer renders this component.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [left <= 0]);
  if (left <= 0) return <strong role="status">The hold has expired. Choose your lesson times again.</strong>;
  const minutes = Math.floor(left / 60000);
  const seconds = Math.floor((left % 60000) / 1000);
  return <strong role="timer">{minutes}:{String(seconds).padStart(2, "0")}</strong>;
}

const STEPS = ["Select time", "Booked", "Paid", "Completed"];
function BookingProgress({ booking }: { booking: Booking }) {
  const { status } = booking;
  const cancelled = status === "CANCELLED";
  // Last finished step. A cancelled booking stops at the step it never reached (marked with a cross).
  const reached = cancelled
    ? booking.paidAt
      ? 2
      : 1
    : status === "PAYMENT_DUE"
      ? 1
      : status === "CONFIRMED"
        ? 2
        : 3;
  // The next step is in progress: it gets a pulsing ring and a moving line leading to it.
  const live = !cancelled && reached < STEPS.length - 1;
  const fill = (reached / (STEPS.length - 1)) * 100;
  return (
    <div
      className={`booking-progress${cancelled ? " is-cancelled" : ""}`}
      role="img"
      aria-label={cancelled ? "Booking cancelled" : `Step ${reached + 1} of ${STEPS.length}: ${STEPS[reached]}`}
    >
      <div className="booking-progress-track" aria-hidden="true">
        <span style={{ width: `${fill}%` }} />
        {live && (
          <span
            className="booking-progress-live"
            style={{ left: `${(reached / (STEPS.length - 1)) * 100}%`, width: `${100 / (STEPS.length - 1)}%` }}
          />
        )}
      </div>
      <ol aria-hidden="true">
        {STEPS.map((label, index) => {
          const done = index <= reached;
          const crossed = cancelled && index === reached + 1;
          return (
            <li key={label} className={crossed ? "is-crossed" : done ? "is-done" : live && index === reached + 1 ? "is-live" : ""}>
              <i>
                {crossed ? (
                  <svg viewBox="0 0 12 12" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="butt">
                    <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" />
                  </svg>
                ) : done ? (
                  <svg viewBox="0 0 12 12" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="butt" strokeLinejoin="miter">
                    <path d="M2 6.5l2.8 2.8L10 3.5" />
                  </svg>
                ) : null}
              </i>
              {label}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function BookingCard({ booking }: { booking: Booking }) {
  return (
    <article className="panel tutor-card">
      <StatusBadge value={booking.status} corner />
      <div className="stat-line">
        <span>{formatTime(booking.startsAt)}</span>
      </div>
      <h2>
        <Link href={`/bookings/${booking.id}`}>{booking.subject.name}</Link>
      </h2>
      <p className="tutor-card-meta">
        {booking.studentUserId ? `Student: ${booking.studentDisplayName}, ` : ""}
        Tutor: {booking.tutorDisplayName}
      </p>
      <p className="tutor-card-meta">
        <strong>{formatMoney(booking.amount)}</strong>, Online
      </p>
    </article>
  );
}

function BookingsContent() {
  const { account } = useAuth();
  const [view, setView] = useState<"STUDENT" | "TUTOR">("STUDENT");
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<BookingPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setResult(
        await api<BookingPage>(`/bookings?page=${page}&pageSize=20&view=${view}${status ? `&status=${status}` : ""}`),
      );
    } catch (caught) {
      setResult(null);
      setError(errorMessage(caught, "Bookings are unavailable right now."));
    } finally {
      setLoading(false);
    }
  }, [view, status, page]);
  useEffect(() => {
    void load();
  }, [load]);
  return (
    <>
      <header className="page-heading">
        <h1>Your bookings</h1>
      </header>
      {account?.capabilities.includes("TUTOR") && (
        <div className="view-switch" role="group" aria-label="Booking view">
          <button
            className={`button ${view === "STUDENT" ? "" : "button-quiet"}`}
            aria-pressed={view === "STUDENT"}
            onClick={() => { setView("STUDENT"); setPage(1); }}
          >
            As a student
          </button>
          <button
            className={`button ${view === "TUTOR" ? "" : "button-quiet"}`}
            aria-pressed={view === "TUTOR"}
            onClick={() => { setView("TUTOR"); setPage(1); }}
          >
            As a tutor
          </button>
        </div>
      )}
      <div className="view-switch" role="group" aria-label="Booking status">
        {[["", "All"], ["PAYMENT_DUE", "Awaiting payment"], ["CONFIRMED", "Confirmed"], ["COMPLETED", "Completed"], ["CANCELLED", "Cancelled"]].map(([value, label]) => (
          <button key={value} className={`button ${status === value ? "" : "button-quiet"}`} aria-pressed={status === value} onClick={() => { setStatus(value); setPage(1); }}>
            {label}
          </button>
        ))}
      </div>
      {loading && <p role="status">Loading your bookings…</p>}
      {error && (
        <Notice kind="error">
          {error}{" "}
          <button className="button button-quiet" onClick={() => void load()}>
            Try again
          </button>
        </Notice>
      )}
      {result?.items.length === 0 && (
        <section className="empty-state">
          <h2>No bookings yet</h2>
          <p>Choose a tutor and an available lesson time to get started.</p>
          <Link className="button" href="/discover">
            Find a tutor
          </Link>
        </section>
      )}
      <div className="account-grid">
        {result?.items.map((booking) => (
          <BookingCard key={booking.id} booking={booking} />
        ))}
      </div>
      {result && <Pager meta={result.pagination} onPage={setPage} disabled={loading} />}
    </>
  );
}

export function BookingsPage() {
  return (
    <RequireAuth>
      <BookingsContent />
    </RequireAuth>
  );
}

function NewBookingContent() {
  const query = useSearchParams();
  const router = useRouter();
  const tutorId = query.get("tutorId") ?? "";
  const subjectId = query.get("subjectId") ?? "";
  const date = query.get("date") ?? "";
  const availabilityIds = (query.get("slotIds") ?? "")
    .split(",")
    .filter(Boolean);
  const valid =
    isUuid(tutorId) &&
    isUuid(subjectId) &&
    availabilityIds.length > 0 &&
    availabilityIds.length <= 8 &&
    availabilityIds.every(isUuid);
  const [summary, setSummary] = useState<SubjectPageData | null>(null);
  const [loading, setLoading] = useState(valid);
  const [error, setError] = useState("");
  const createAction = useAction();
  useEffect(() => {
    if (!valid) return;
    setLoading(true);
    void api<SubjectPageData>(
      `/discovery/tutors/${tutorId}/subjects/${subjectId}?date=${encodeURIComponent(date)}`,
      { auth: false },
    )
      .then(setSummary)
      .catch((caught) =>
        setError(errorMessage(caught, "We couldn’t load this lesson summary.")),
      )
      .finally(() => setLoading(false));
  }, [valid, tutorId, subjectId, date]);
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    const description = String(
      new FormData(event.currentTarget).get("description") ?? "",
    ).trim();
    const booking = await createAction.run<Booking>("/bookings", { subjectId, availabilityIds, description });
    if (booking) router.push(`/bookings/${booking.id}`);
  }
  if (!valid)
    return (
      <section className="panel">
        <h1 style={{ fontSize: 22 }}>Choose lesson times again</h1>
        <p className="tutor-card-meta">This booking link is incomplete or invalid.</p>
        <Link className="button" href="/discover">
          Find a tutor
        </Link>
      </section>
    );
  const selected =
    summary?.slots.filter((slot) => availabilityIds.includes(slot.id)) ?? [];
  const slotsAvailable = selected.length === availabilityIds.length;
  const estimated = summary
    ? (
        (Number(summary.subject.hourlyRate) * availabilityIds.length) /
        2
      ).toFixed(2)
    : null;
  return (
    <>
      <header className="page-heading">
        <h1>Review your lesson</h1>
      </header>
      {loading && <p role="status" className="tutor-card-meta">Loading lesson summary…</p>}
      {error && <Notice kind="error">{error}</Notice>}
      <ActionMessages action={createAction} />
      {createAction.notice && <p><Link className="text-link" href="/bookings">View your bookings</Link></p>}
      {summary && (
        <section className="panel booking-new">
          {!slotsAvailable && <Notice kind="error">Some selected times are no longer available. Choose your lesson times again.</Notice>}
          <div className="subject-head-top">
            <h2>{summary.subject.name}</h2>
            <Link className="subject-tutor" href={`/tutors/${summary.tutor.id}`}>
              With {summary.tutor.displayName}
            </Link>
          </div>
          <div className="summary-rows">
            <div>
              <span>Time</span>
              <strong>
                {selected.length
                  ? `${formatTime(selected[0].startsAt)} to ${new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Bangkok", timeStyle: "short" }).format(new Date(selected[selected.length - 1].endsAt))}`
                  : `${availabilityIds.length} selected half-hour slots`}
              </strong>
            </div>
            <div>
              <span>Duration</span>
              <strong>{availabilityIds.length / 2} hour(s)</strong>
            </div>
            <div>
              <span>Estimated total</span>
              <strong>THB {estimated}</strong>
            </div>
          </div>
          <form className="form" onSubmit={submit}>
            <div className="field">
              <label htmlFor="description">
                Learning goal or note (optional)
              </label>
              <textarea
                id="description"
                name="description"
                maxLength={2000}
                rows={4}
                disabled={createAction.pending || createAction.uncertain}
              />
            </div>
            <div className="slot-footer">
              <span className="tutor-card-meta">
                Holding these times keeps them for you briefly while you pay from your wallet.
              </span>
              <span className="button-row">
                <Link
                  className="button button-quiet"
                  href={`/tutors/${tutorId}/subjects/${subjectId}`}
                >
                  Choose different times
                </Link>
                <button className="button" disabled={createAction.pending || createAction.uncertain || !slotsAvailable}>
                  {createAction.pending ? "Holding times…" : "Hold these times"}
                </button>
              </span>
            </div>
          </form>
        </section>
      )}
    </>
  );
}

export function NewBookingPage() {
  return (
    <RequireAuth>
      <NewBookingContent />
    </RequireAuth>
  );
}

function BookingDetailContent({ bookingId }: { bookingId: string }) {
  const { account } = useAuth();
  const [booking, setBooking] = useState<Booking | null>(null);
  const [etag, setEtag] = useState("");
  const [quote, setQuote] = useState<CancellationQuote | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const load = useCallback(async () => {
    setError("");
    try {
      const result = await apiResponse<Booking>(`/bookings/${bookingId}`);
      setBooking(result.data);
      setEtag(result.headers.get("ETag") ?? `"${result.data.revision}"`);
    } catch (caught) {
      setError(errorMessage(caught, "We couldn’t load this booking."));
    }
  }, [bookingId]);
  useEffect(() => {
    if (isUuid(bookingId)) void load();
  }, [load, bookingId]);
  const action = useAction(load);
  async function command(path: string, body?: unknown, method = "POST") {
    setError("");
    setNotice("");
    const result = await action.run(path, body, method, quote && /\/(tutor-)?cancel$/.test(path) ? quote.bookingRevision : etag.replace(/^"|"$/g, ""));
    if (result) {
      setQuote(null);
      window.dispatchEvent(new Event("wallet:changed"));
    }
    // A rejected action may have advanced the booking (for example a declined payment), so show its current state and revision.
    else await load();
  }
  async function requestQuote() {
    setPending(true);
    setError("");
    try {
      setQuote(
        await api<CancellationQuote>(
          `/bookings/${bookingId}/${booking?.studentUserId === account?.id ? "cancellation-quote" : "tutor-cancellation-quote"}`,
        ),
      );
    } catch (caught) {
      setError(
        errorMessage(caught, "We couldn’t calculate the cancellation quote."),
      );
    } finally {
      setPending(false);
    }
  }
  if (!isUuid(bookingId))
    return (
      <section className="panel">
        <h1 style={{ fontSize: 22 }}>We couldn’t find that booking.</h1>
        <p className="tutor-card-meta">The booking address is invalid.</p>
        <Link className="button" href="/bookings">
          Back to bookings
        </Link>
      </section>
    );
  const isStudent = booking?.studentUserId === account?.id;
  const isTutor = booking?.tutorUserId === account?.id;
  const busy = pending || action.pending || action.uncertain || action.operation?.status === "PENDING";
  const endTime = booking
    ? new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Bangkok", timeStyle: "short" }).format(new Date(booking.endsAt))
    : "";
  return (
    <>
      {error && (
        <Notice kind="error">
          {error}
          {booking?.status === "PAYMENT_DUE" && (
            <Link
              className="text-link"
              href={`/wallet?returnToBookingId=${bookingId}`}
            >
              {" "}
              Add funds
            </Link>
          )}
        </Notice>
      )}
      {notice && <Notice kind="success">{notice}</Notice>}
      <ActionMessages action={action} />
      {!booking && !error && <p role="status" className="tutor-card-meta">Loading booking…</p>}
      <header className="page-heading">
        <h1>Booking</h1>
      </header>
      {booking && <BookingProgress booking={booking} />}
      {booking && (
        <section className="panel booking-new">
          <StatusBadge value={booking.status} corner />
          <div className="booking-title">
            <h2>{booking.subject.name}</h2>
            <p className="tutor-card-meta">
              {isStudent ? "With " : "Student: "}
              <strong className="booking-who">
                {isStudent ? booking.tutorDisplayName : booking.studentDisplayName}
              </strong>
            </p>
          </div>
          <div className="summary-rows">
            <div>
              <span>Time</span>
              <strong>{formatTime(booking.startsAt)} to {endTime}</strong>
            </div>
            {booking.description && (
              <div>
                <span>Learning note</span>
                <strong className="summary-note">{booking.description}</strong>
              </div>
            )}
            {booking.holdExpiresAt && (
              <div>
                <span>Time left to pay</span>
                <HoldCountdown expiresAt={booking.holdExpiresAt} onExpired={() => void load()} />
              </div>
            )}
            <div>
              <span>Total</span>
              <strong>{formatMoney(booking.amount)}</strong>
            </div>
          </div>
          {isTutor && booking.meeting.canEdit && (
            <form
              className="booking-meeting"
              onSubmit={(event) => {
                event.preventDefault();
                const url = String(
                  new FormData(event.currentTarget).get("meetingUrl") ?? "",
                ).trim();
                void command(
                  `/bookings/${bookingId}/meeting-link`,
                  { customMeetingUrl: url || null },
                  "PATCH",
                );
              }}
            >
              <Field
                id="meetingUrl"
                label="Custom HTTPS meeting link"
                type="url"
                defaultValue={booking.meeting.customMeetingUrl ?? ""}
              />
              <button className="button button-quiet" disabled={busy}>
                Save link
              </button>
            </form>
          )}
          <div className="slot-footer flush">
            <span className="button-row">
              <Link
                className="button button-quiet"
                href={`/messages/${isStudent ? booking.tutorUserId : booking.studentUserId}?view=${isStudent ? "STUDENT" : "TUTOR"}`}
              >
                Message {isStudent ? "tutor" : "student"}
              </Link>
              {(isStudent || isTutor) &&
                ["PAYMENT_DUE", "CONFIRMED"].includes(booking.status) && (
                  <button
                    className="button button-quiet"
                    disabled={busy}
                    onClick={() => void requestQuote()}
                  >
                    Cancel booking
                  </button>
                )}
              {isStudent && booking.status === "COMPLETED" && (
                <Link
                  className="button button-quiet"
                  href={`/disputes?bookingId=${bookingId}`}
                >
                  Open a dispute
                </Link>
              )}
            </span>
            <span className="button-row">
              {booking.meeting.state === "PROVISIONING" && (
                <span className="tooltip-wrap" data-tip="Meeting access is being prepared.">
                  <button className="button" disabled aria-disabled="true">
                    Join lesson
                  </button>
                </span>
              )}
              {booking.meeting.canJoin && booking.meeting.effectiveUrl && (
                <a
                  className="button"
                  href={booking.meeting.effectiveUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  Join lesson
                </a>
              )}
              {isStudent && booking.status === "PAYMENT_DUE" && (
                <button
                  className="button"
                  disabled={busy}
                  onClick={() => void command(`/bookings/${bookingId}/confirm-payment`)}
                >
                  {pending ? "Processing…" : "Pay from wallet"}
                </button>
              )}
              {isStudent && booking.status === "COMPLETED" && booking.canReview && (
                <Link className="button" href={`/reviews/new?bookingId=${bookingId}`}>
                  Write a review
                </Link>
              )}
              {isTutor &&
                booking.status === "CONFIRMED" &&
                new Date(booking.endsAt).getTime() <= Date.now() && (
                  <button
                    className="button"
                    disabled={busy}
                    onClick={() => void command(`/bookings/${bookingId}/confirm-completion`)}
                  >
                    Confirm lesson completed
                  </button>
                )}
            </span>
          </div>
        </section>
      )}
      {booking && (
        <LegalModal
          open={Boolean(quote)}
          title="Cancel this booking"
          onClose={() => setQuote(null)}
          actions={
            <div className="button-row" style={{ justifyContent: "flex-end" }}>
              <button type="button" className="button button-quiet" onClick={() => setQuote(null)}>
                Keep booking
              </button>
              <button type="submit" form="cancel-form" className="button button-danger" disabled={busy}>
                Confirm cancellation
              </button>
            </div>
          }
        >
          {quote && (
            <form
              id="cancel-form"
              className="form"
              onSubmit={(event) => {
                event.preventDefault();
                const reason = String(
                  new FormData(event.currentTarget).get("cancelReason") ?? "",
                ).trim();
                void command(`/bookings/${bookingId}/${isStudent ? "cancel" : "tutor-cancel"}`, {
                  quoteId: quote.quoteId,
                  reason,
                });
              }}
            >
              <div className="summary-rows">
                <div>
                  <span>Refund</span>
                  <strong>{formatMoney(quote.refund)}</strong>
                </div>
                <div>
                  <span>Fee</span>
                  <strong>{formatMoney(quote.fee)}</strong>
                </div>
              </div>
              {quote.requiresWarning && (
                <Notice kind="info">
                  This is a late cancellation. Review the refund and fee before
                  confirming.
                </Notice>
              )}
              <Field id="cancelReason" label="Reason (optional)" maxLength={500} />
            </form>
          )}
        </LegalModal>
      )}
    </>
  );
}

export function BookingDetailPage({
  params,
}: {
  params: Promise<{ bookingId: string }>;
}) {
  const { bookingId } = use(params);
  return (
    <RequireAuth>
      <BookingDetailContent bookingId={bookingId} />
    </RequireAuth>
  );
}
