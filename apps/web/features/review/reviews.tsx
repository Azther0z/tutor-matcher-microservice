"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Field, Notice } from "@/components/field";
import { Dropdown } from "@/components/dropdown";
import { RequireAuth, useAuth } from "@/lib/auth-context";
import { api, errorMessage } from "@/lib/api";
import {
  ActionMessages,
  bangkokTime,
  Pager,
  ResourceState,
  useAction,
  useResource,
} from "../tutor/common";
import type { Page } from "../tutor/types";
import type { Review } from "./types";

function ReviewCard({
  review,
  reload,
}: {
  review: Review;
  reload: () => Promise<void>;
}) {
  const { account } = useAuth();
  const reply = useAction(reload);
  const flag = useAction();
  const [flagged, setFlagged] = useState(false);
  async function submitReply(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await reply.run(
      `/reviews/${review.id}/reply`,
      {
        text: String(
          new FormData(event.currentTarget).get("text") ?? "",
        ).trim(),
      },
      "POST",
      review.revision,
    );
  }
  async function submitFlag(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const result = await flag.run(`/reviews/${review.id}/flags`, {
      reason: String(
        new FormData(event.currentTarget).get("reason") ?? "",
      ).trim(),
    });
    if (result) setFlagged(true);
  }
  return (
    <article className="review-item">
      <div className="review-top">
        <strong>{review.studentDisplayName}</strong>
        <time dateTime={review.createdAt}>
          {bangkokTime(review.createdAt)}
        </time>
      </div>
      <span className="review-stars" role="img" aria-label={`${review.rating} out of 5 stars`}>
        {"★".repeat(review.rating)}
        <span className="review-stars-off">{"★".repeat(5 - review.rating)}</span>
      </span>
      {review.headline && <h3>{review.headline}</h3>}
      <p className="review-text" style={{ whiteSpace: "pre-wrap" }}>{review.text}</p>
      {review.reply && (
        <div className="review-reply">
          <div className="review-top">
            <strong>Tutor reply</strong>
            <time dateTime={review.reply.createdAt}>
              {bangkokTime(review.reply.createdAt)}
            </time>
          </div>
          <p className="review-text" style={{ whiteSpace: "pre-wrap" }}>{review.reply.text}</p>
        </div>
      )}
      {account?.id === review.tutorUserId && !review.reply && (
        <form className="form" onSubmit={(event) => void submitReply(event)}>
          <h3>Reply to this review</h3>
          <ActionMessages action={reply} />
          <div className="field">
            <label htmlFor={`reply-${review.id}`}>Your reply</label>
            <textarea
              id={`reply-${review.id}`}
              name="text"
              required
              maxLength={5000}
              rows={3}
            />
          </div>
          <p className="tutor-card-meta">Only one reply is allowed.</p>
          <button
            className="button"
            disabled={reply.pending || reply.uncertain}
          >
            Post tutor reply
          </button>
        </form>
      )}
      {account ? (
        <details className="review-report">
          <summary>Report</summary>
          <ActionMessages action={flag} />
          {flagged ? (
            <p role="status">Your report was submitted for moderation.</p>
          ) : (
            <form className="form" onSubmit={(event) => void submitFlag(event)}>
              <div className="field">
                <label htmlFor={`flag-${review.id}`}>Report reason</label>
                <textarea
                  id={`flag-${review.id}`}
                  name="reason"
                  required
                  maxLength={2000}
                  rows={3}
                />
              </div>
              <p className="tutor-card-meta">Each person can report a review once.</p>
              <button
                className="button button-quiet"
                disabled={flag.pending || flag.uncertain}
              >
                Submit report
              </button>
            </form>
          )}
        </details>
      ) : (
        <Link
          className="review-report-link"
          href={`/login?returnTo=${encodeURIComponent(`/tutors/${review.tutorId}`)}`}
        >
          Sign in to report
        </Link>
      )}
    </article>
  );
}
export function ReviewList({
  tutorId,
  subjectId,
}: {
  tutorId: string;
  subjectId?: string;
}) {
  const [items, setItems] = useState<Review[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const nextPage = useRef(1);
  const busy = useRef(false);
  const sentinel = useRef<HTMLDivElement>(null);
  const url = useCallback(
    (page: number) =>
      `/reviews?${new URLSearchParams({
        tutorId,
        page: String(page),
        pageSize: "10",
        ...(subjectId ? { subjectId } : {}),
      })}`,
    [tutorId, subjectId],
  );
  const loadMore = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    setLoading(true);
    setError("");
    try {
      const result = await api<Page<Review>>(url(nextPage.current), { auth: false });
      setItems((previous) => [...previous, ...result.items]);
      setTotal(result.pagination.totalItems);
      setHasMore(nextPage.current < result.pagination.totalPages);
      nextPage.current += 1;
    } catch (caught) {
      setError(errorMessage(caught, "Reviews are unavailable right now."));
      setHasMore(false);
    } finally {
      busy.current = false;
      setLoading(false);
    }
  }, [url]);
  // Refetch everything loaded so far, so a posted reply shows up in place without losing scroll position.
  const reload = useCallback(async () => {
    const pages = nextPage.current - 1;
    const all: Review[] = [];
    for (let page = 1; page <= Math.max(pages, 1); page += 1) {
      const result = await api<Page<Review>>(url(page), { auth: false });
      all.push(...result.items);
    }
    setItems(all);
  }, [url]);
  useEffect(() => {
    nextPage.current = 1;
    setItems([]);
    setTotal(null);
    setHasMore(true);
    void loadMore();
  }, [loadMore]);
  useEffect(() => {
    const node = sentinel.current;
    if (!node || !hasMore) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) void loadMore();
      },
      { rootMargin: "300px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasMore, loadMore, items.length]);
  return (
    <section className="review-section">
      <h2>
        Reviews{total !== null && total > 0 ? ` (${total})` : ""}
      </h2>
      {total === 0 && <p className="tutor-card-meta">No reviews yet.</p>}
      {items.length > 0 && (
        <div className="review-list">
          {items.map((review) => (
            <ReviewCard
              key={`${review.id}:${review.revision}`}
              review={review}
              reload={reload}
            />
          ))}
        </div>
      )}
      {error && (
        <Notice kind="error">
          {error}{" "}
          <button
            type="button"
            className="button button-quiet"
            onClick={() => {
              setHasMore(true);
              void loadMore();
            }}
          >
            Try again
          </button>
        </Notice>
      )}
      {loading && <p className="tutor-card-meta" role="status">Loading reviews…</p>}
      {hasMore && !error && <div ref={sentinel} aria-hidden="true" style={{ height: 1 }} />}
    </section>
  );
}

type ReviewBooking = {
  id: string;
  status: string;
  studentUserId: string;
  canReview: boolean;
  tutorId: string;
  tutorDisplayName: string;
  subject: { name: string };
  completedAt: string | null;
};
function ReviewWriterContent({ bookingId }: { bookingId: string }) {
  const { account } = useAuth();
  const resource = useResource<ReviewBooking>(
    bookingId ? `/bookings/${encodeURIComponent(bookingId)}` : null,
  );
  const [created, setCreated] = useState<Review | null>(null);
  const action = useAction();
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const result = await action.run<Review>(`/bookings/${bookingId}/review`, {
      rating: Number(form.get("rating")),
      text: String(form.get("text") ?? "").trim(),
      headline: String(form.get("headline") ?? "").trim(),
    });
    if (result) setCreated(result);
  }
  const booking = resource.data;
  return (
    <>
      <header className="section-heading">
        <h1>Write a review</h1>
        <p>
          Reviews are linked to a completed booking. Only its student can write
          one review.
        </p>
      </header>
      {!bookingId ? (
        <Notice kind="info">
          Open a completed booking and choose Write a review.
        </Notice>
      ) : (
        <>
          <ResourceState
            loading={resource.loading}
            error={resource.error}
            failure={resource.failure}
            retry={() => void resource.reload()}
            backHref="/reviews"
            backLabel="Back to reviews"
          />
          {booking && (
            <section className="panel">
              <h2>{booking.subject.name}</h2>
              <p>
                With {booking.tutorDisplayName}. Booking status:{" "}
                {booking.status}.
              </p>
              <ActionMessages action={action} />
              {created ? (
                <>
                  <Notice kind="success">
                    Your review has been published.
                  </Notice>
                  <Link
                    className="text-link"
                    href={`/tutors/${created.tutorId}`}
                  >
                    View tutor reviews
                  </Link>
                </>
              ) : booking.status === "COMPLETED" &&
                booking.canReview &&
                booking.studentUserId === account?.id ? (
                <form className="form" onSubmit={(event) => void submit(event)}>
                  <div className="field">
                    <label htmlFor="rating">Rating</label>
                    <Dropdown id="rating" name="rating" defaultValue="5" options={
                      [5, 4, 3, 2, 1].map((rating) => ({ value: String(rating), label: `${rating} out of 5` }))
                    } />
                  </div>
                  <Field
                    id="headline"
                    label="Headline (optional)"
                    maxLength={200}
                  />
                  <div className="field">
                    <label htmlFor="review-text">Your review</label>
                    <textarea
                      id="review-text"
                      name="text"
                      required
                      maxLength={5000}
                      rows={6}
                    />
                  </div>
                  <button
                    className="button"
                    disabled={action.pending || action.uncertain}
                  >
                    Publish review
                  </button>
                </form>
              ) : (
                <Notice kind="info">
                  This booking is not eligible for a new review. It must be
                  completed, belong to you as the student, and have no existing
                  review.
                </Notice>
              )}
              <p>
                <Link className="text-link" href={`/bookings/${booking.id}`}>
                  Back to booking
                </Link>
              </p>
            </section>
          )}
        </>
      )}
    </>
  );
}
export function ReviewWriter({ bookingId }: { bookingId: string }) {
  return (
    <RequireAuth>
      <ReviewWriterContent bookingId={bookingId} />
    </RequireAuth>
  );
}
export function ReviewWriterFromQuery() {
  const query = useSearchParams();
  return <ReviewWriter bookingId={query.get("bookingId") ?? ""} />;
}
export function ReviewsFromQuery() {
  const query = useSearchParams();
  const tutorId = query.get("tutorId");
  return (
    <>
      <h1>Lesson reviews</h1>
      {tutorId ? (
        <ReviewList
          tutorId={tutorId}
          subjectId={query.get("subjectId") ?? undefined}
        />
      ) : (
        <>
          <p>Choose a tutor or subject to read its verified lesson reviews.</p>
          <Link className="text-link" href="/discover">
            Find a tutor
          </Link>
        </>
      )}
    </>
  );
}
