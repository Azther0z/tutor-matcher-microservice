"use client";

import Link from "next/link";
import { use, useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Field, Notice } from "@/components/field";
import { StatusBadge } from "@/features/wallet/common";
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

function BookingCard({ booking }: { booking: Booking }) {
  return (
    <article className="panel">
      <div className="stat-line">
        <StatusBadge value={booking.status} />
        <span>{formatTime(booking.startsAt)}</span>
      </div>
      <h2>{booking.subject.name}</h2>
      <p>
        {booking.studentUserId ? `Student: ${booking.studentDisplayName}` : ""}{" "}
        · Tutor: {booking.tutorDisplayName}
      </p>
      <p>
        <strong>{formatMoney(booking.amount)}</strong> · Online
      </p>
      <Link className="button" href={`/bookings/${booking.id}`}>
        View booking
      </Link>
    </article>
  );
}

function BookingsContent() {
  const { account } = useAuth();
  const [view, setView] = useState<"STUDENT" | "TUTOR">("STUDENT");
  const [result, setResult] = useState<BookingPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setResult(
        await api<BookingPage>(`/bookings?page=1&pageSize=20&view=${view}`),
      );
    } catch (caught) {
      setResult(null);
      setError(errorMessage(caught, "Bookings are unavailable right now."));
    } finally {
      setLoading(false);
    }
  }, [view]);
  useEffect(() => {
    void load();
  }, [load]);
  return (
    <>
      <header className="section-heading">
        <p className="eyebrow">YOUR LESSONS</p>
        <h1>Your bookings</h1>
        <p>
          Review upcoming lessons, payments, meeting access, and completed
          lessons.
        </p>
      </header>
      {account?.capabilities.includes("TUTOR") && (
        <div className="view-switch" role="group" aria-label="Booking view">
          <button
            className={`button ${view === "STUDENT" ? "" : "button-quiet"}`}
            onClick={() => setView("STUDENT")}
          >
            As a student
          </button>
          <button
            className={`button ${view === "TUTOR" ? "" : "button-quiet"}`}
            onClick={() => setView("TUTOR")}
          >
            As a tutor
          </button>
        </div>
      )}
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
        <h1>Choose lesson times again</h1>
        <p>This booking link is incomplete or invalid.</p>
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
      <header className="section-heading">
        <p className="eyebrow">NEW BOOKING</p>
        <h1>Review your lesson</h1>
        <p>
          Creating the booking holds these times briefly while you pay from your
          wallet.
        </p>
      </header>
      {loading && <p role="status">Loading lesson summary…</p>}
      {error && <Notice kind="error">{error}</Notice>}
      <ActionMessages action={createAction} />
      {createAction.notice && <p><Link className="text-link" href="/bookings">View your bookings</Link></p>}
      {summary && (
        <section className="panel">
          {!slotsAvailable && <Notice kind="error">Some selected times are no longer available. Choose your lesson times again.</Notice>}
          <h2>{summary.subject.name}</h2>
          <p>With {summary.tutor.displayName}</p>
          <dl className="detail-list">
            <dt>Time</dt>
            <dd>
              {selected.length
                ? `${formatTime(selected[0].startsAt)} to ${new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Bangkok", timeStyle: "short" }).format(new Date(selected[selected.length - 1].endsAt))}`
                : `${availabilityIds.length} selected half-hour slots`}
            </dd>
            <dt>Duration</dt>
            <dd>{availabilityIds.length / 2} hour(s)</dd>
            <dt>Estimated total</dt>
            <dd>THB {estimated}</dd>
          </dl>
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
            <div className="button-row">
              <button className="button" disabled={createAction.pending || createAction.uncertain || !slotsAvailable}>
                {createAction.pending ? "Holding times…" : "Hold these times"}
              </button>
              <Link
                className="button button-quiet"
                href={`/tutors/${tutorId}/subjects/${subjectId}`}
              >
                Choose different times
              </Link>
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
    const result = await action.run(path, body, method, quote && path.endsWith("/cancel") ? quote.bookingRevision : etag.replace(/^"|"$/g, ""));
    if (result) setQuote(null);
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
        <h1>We couldn’t find that booking.</h1>
        <p>The booking address is invalid.</p>
        <Link className="button" href="/bookings">
          Back to bookings
        </Link>
      </section>
    );
  const isStudent = booking?.studentUserId === account?.id;
  const isTutor = booking?.tutorUserId === account?.id;
  return (
    <>
      <p>
        <Link className="text-link" href="/bookings">
          ← All bookings
        </Link>
      </p>
      <header className="section-heading">
        <p className="eyebrow">YOUR LESSON</p>
        <h1>Booking</h1>
        <p>
          {booking
            ? `${booking.subject.name} with ${booking.tutorDisplayName}`
            : "Lesson details"}
        </p>
      </header>
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
      {!booking && !error && <p role="status">Loading booking…</p>}
      {booking && (
        <>
          <section className="panel">
            <div className="stat-line">
              <StatusBadge value={booking.status} />
              <strong>{formatMoney(booking.amount)}</strong>
            </div>
            <h2>{booking.subject.name}</h2>
            <dl className="detail-list">
              <dt>Starts</dt>
              <dd>{formatTime(booking.startsAt)}</dd>
              <dt>Ends</dt>
              <dd>{formatTime(booking.endsAt)}</dd>
              <dt>Student</dt>
              <dd>{booking.studentDisplayName}</dd>
              <dt>Tutor</dt>
              <dd>{booking.tutorDisplayName}</dd>
              {booking.description && (
                <>
                  <dt>Learning note</dt>
                  <dd>{booking.description}</dd>
                </>
              )}
              {booking.holdExpiresAt && (
                <>
                  <dt>Payment hold expires</dt>
                  <dd>{formatTime(booking.holdExpiresAt)}</dd>
                </>
              )}
            </dl>
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
            {booking.meeting.state === "PROVISIONING" && (
              <Notice kind="info">Meeting access is being prepared.</Notice>
            )}
          </section>
          <section className="panel">
            <h2>Booking actions</h2>
            <div className="button-row">
              {isStudent && booking.status === "PAYMENT_DUE" && (
                <button
                  className="button"
                  disabled={pending || action.pending || action.uncertain || action.operation?.status === "PENDING"}
                  onClick={() =>
                    void command(`/bookings/${bookingId}/confirm-payment`)
                  }
                >
                  {pending ? "Processing…" : "Pay from wallet"}
                </button>
              )}
              {isStudent &&
                booking.status === "COMPLETED" &&
                booking.canReview && (
                  <Link
                    className="button"
                    href={`/reviews/new?bookingId=${bookingId}`}
                  >
                    Write a review
                  </Link>
                )}
              {isStudent && booking.status === "COMPLETED" && (
                <Link
                  className="button button-quiet"
                  href={`/disputes?bookingId=${bookingId}`}
                >
                  Open a dispute
                </Link>
              )}
              {isTutor &&
                booking.status === "CONFIRMED" &&
                new Date(booking.endsAt).getTime() <= Date.now() && (
                  <button
                    className="button"
                    disabled={pending || action.pending || action.uncertain || action.operation?.status === "PENDING"}
                    onClick={() =>
                      void command(`/bookings/${bookingId}/confirm-completion`)
                    }
                  >
                    Confirm lesson completed
                  </button>
                )}
              {(isStudent || isTutor) &&
                ["PAYMENT_DUE", "CONFIRMED"].includes(booking.status) && (
                  <button
                    className="button button-quiet"
                    disabled={pending || action.pending || action.uncertain || action.operation?.status === "PENDING"}
                    onClick={() => void requestQuote()}
                  >
                    Review cancellation
                  </button>
                )}
              <Link
                className="button button-quiet"
              href={`/messages/${isStudent ? booking.tutorUserId : booking.studentUserId}?view=${isStudent ? "STUDENT" : "TUTOR"}`}
              >
                Message {isStudent ? "tutor" : "student"}
              </Link>
            </div>
            {isTutor && booking.meeting.canEdit && (
              <form
                className="inline-form"
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
                <button className="button" disabled={pending || action.pending || action.uncertain || action.operation?.status === "PENDING"}>
                  Save meeting link
                </button>
              </form>
            )}
          </section>
          {quote && (
            <section className="panel danger-panel">
              <h2>Cancellation quote</h2>
              <p>
                Refund: <strong>{formatMoney(quote.refund)}</strong> · Fee:{" "}
                <strong>{formatMoney(quote.fee)}</strong>
              </p>
              {quote.requiresWarning && (
                <Notice kind="info">
                  This is a late cancellation. Review the refund and fee before
                  confirming.
                </Notice>
              )}
              <form
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
                <Field
                  id="cancelReason"
                  label="Reason (optional)"
                  maxLength={500}
                />
                <button className="button button-danger" disabled={pending || action.pending || action.uncertain || action.operation?.status === "PENDING"}>
                  Confirm cancellation
                </button>
              </form>
            </section>
          )}
        </>
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
