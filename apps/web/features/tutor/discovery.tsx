"use client";

import { VerifiedBadge } from "@/components/verified-badge";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { Field, Notice, focusFirstInvalid } from "@/components/field";
import { Dropdown } from "@/components/dropdown";
import { useAuth } from "@/lib/auth-context";
import { ReviewList } from "../review/reviews";
import {
  bangkokDate,
  bangkokTime,
  Pager,
  ResourceState,
  useResource,
} from "./common";
import type {
  LearningAreas,
  Page,
  PublicTutor,
  SearchItem,
  Slot,
  SubjectPageData,
} from "./types";

const filterNames = [
  "q",
  "tutorName",
  "learningArea",
  "minRate",
  "maxRate",
  "minRating",
  "format",
  "sort",
] as const;
function priceProblems(
  min: string | null,
  max: string | null,
): { min?: string; max?: string } {
  const problems: { min?: string; max?: string } = {};
  const lower = min === null ? null : Number(min);
  const upper = max === null ? null : Number(max);
  if (lower !== null && (!Number.isFinite(lower) || lower < 0))
    problems.min = "Enter a rate of 0 or more.";
  if (upper !== null && (!Number.isFinite(upper) || upper < 0))
    problems.max = "Enter a rate of 0 or more.";
  if (!problems.min && !problems.max && lower !== null && upper !== null && lower > upper)
    problems.max = "The maximum rate must be at least the minimum rate.";
  return problems;
}
function RatingLabel({
  average,
  count,
}: {
  average: number | null;
  count: number;
}) {
  return (
    <span>
      {average === null ? "No ratings yet" : `${average.toFixed(1)}/5`} ({count}{" "}
      reviews)
    </span>
  );
}
export function Discover() {
  const query = useSearchParams();
  const router = useRouter();
  const { account, ready } = useAuth();
  const preferences = useResource<{ learningAreas: string[] }>(
    account ? "/profiles/me/student" : null,
  );
  const areas = useResource<LearningAreas>("/discovery/learning-areas", false);
  const range = useResource<{
    minimum: { amount: string };
    maximum: { amount: string };
  }>("/discovery/price-range", false);
  const parameters = new URLSearchParams();
  for (const key of filterNames) {
    const value = query.get(key);
    if (value) parameters.set(key, value);
  }
  parameters.set("page", query.get("page") ?? "1");
  parameters.set("pageSize", "20");
  if (!parameters.has("sort")) parameters.set("sort", "RECOMMENDED");
  if (preferences.data?.learningAreas.length)
    parameters.set(
      "preferredLearningAreas",
      preferences.data.learningAreas.join(","),
    );
  const resource = useResource<Page<SearchItem>>(
    ready && (!account || !preferences.loading)
      ? `/discovery/tutors?${parameters}`
      : null,
  );
  const [priceErrors, setPriceErrors] = useState<{ min?: string; max?: string }>({});
  // One outage state for the whole catalogue: the form stays off until the learning areas and search can load.
  const searchDown = Boolean(
    areas.error || range.error || (resource.failure?.outage ?? false),
  );
  const reloadCatalogue = () => {
    void areas.reload();
    void range.reload();
    void resource.reload();
  };
  const navigate = (page: number) => {
    const next = new URLSearchParams(query.toString());
    next.set("page", String(page));
    router.push(`/discover?${next}`);
  };
  function filter(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const next = new URLSearchParams();
    for (const key of filterNames) {
      const value = String(form.get(key) ?? "").trim();
      if (value) next.set(key, value);
    }
    // Sort lives in the results bar, outside this form.
    if (query.get("sort")) next.set("sort", query.get("sort") as string);
    const problems = priceProblems(next.get("minRate"), next.get("maxRate"));
    setPriceErrors(problems);
    if (problems.min || problems.max) {
      focusFirstInvalid(formElement);
      return;
    }
    router.push(`/discover?${next}`);
  }
  const apply = (updates: Record<string, string | null>) => {
    const next = new URLSearchParams(query.toString());
    for (const [key, value] of Object.entries(updates)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    next.delete("page");
    router.push(`/discover?${next}`);
  };
  const rating = Number(query.get("minRating") ?? 0);
  const format = query.get("format") ?? "";
  const resultCount = resource.data?.pagination.totalItems ?? 0;
  return (
    <>
      <div className="search-layout">
        <aside className="search-side" aria-label="Filters">
          {searchDown && (
            <Notice kind="error" requestId={resource.failure?.requestId}>
              {resource.failure?.outage
                ? resource.failure.message
                : "Search is unavailable right now."}{" "}
              <button className="button button-quiet" onClick={reloadCatalogue}>
                Try again
              </button>
            </Notice>
          )}
          <form key={query.toString()} className="form" onSubmit={filter} noValidate>
            <fieldset className="plain-fieldset" disabled={searchDown || areas.loading}>
              <div className="search-fields">
              <Field
                id="search-keyword"
                name="q"
                label="Keyword"
                placeholder="Subject or topic"
                maxLength={200}
                defaultValue={query.get("q") ?? ""}
              />
              <Field
                id="search-tutor"
                name="tutorName"
                label="Tutor name"
                placeholder="First or last name"
                maxLength={200}
                defaultValue={query.get("tutorName") ?? ""}
              />
              <div className="field">
                <label htmlFor="learningArea">Learning area</label>
                <Dropdown
                  id="learningArea"
                  name="learningArea"
                  defaultValue={query.get("learningArea") ?? ""}
                  onValueChange={(value) => apply({ learningArea: value })}
                  options={[
                    { value: "", label: "All learning areas" },
                    ...(areas.data?.items.map((area) => ({ value: area.id, label: area.label })) ?? []),
                  ]}
                />
              </div>
              <div className="field">
                <span className="field-label" id="rating-label">Minimum rating</span>
                <div className="star-picker" role="group" aria-labelledby="rating-label">
                  {[1, 2, 3, 4, 5].map((star) => (
                    <button
                      key={star}
                      type="button"
                      className={`star ${star <= rating ? "on" : ""}`}
                      aria-label={`${star} ${star === 1 ? "star" : "stars"} and up`}
                      aria-pressed={rating === star}
                      onClick={() => apply({ minRating: rating === star ? null : String(star) })}
                    >
                      ★
                    </button>
                  ))}
                </div>
                <span className="field-hint">{rating ? `${rating} ${rating === 1 ? "star" : "stars"} & up` : "Any rating"}</span>
                <input type="hidden" name="minRating" value={query.get("minRating") ?? ""} />
              </div>
              <div className="field-set">
                <Field
                  id="minimum-rate"
                  name="minRate"
                  label="Min price (THB/hr)"
                  inputMode="decimal"
                  defaultValue={query.get("minRate") ?? ""}
                  error={priceErrors.min}
                />
                <Field
                  id="maximum-rate"
                  name="maxRate"
                  label="Max price (THB/hr)"
                  inputMode="decimal"
                  defaultValue={query.get("maxRate") ?? ""}
                  error={priceErrors.max}
                />
              </div>
              {range.data && (
                <p className="field-hint">
                  Published rates: THB {range.data.minimum.amount} to {range.data.maximum.amount} per hour.
                </p>
              )}
              <div className="field">
                <span className="field-label" id="format-label">Format</span>
                <div className="pill-toggle" role="group" aria-labelledby="format-label">
                  <button type="button" className={format === "" ? "on" : ""} aria-pressed={format === ""} onClick={() => apply({ format: null })}>Any</button>
                  <button type="button" className={format === "ONLINE" ? "on" : ""} aria-pressed={format === "ONLINE"} onClick={() => apply({ format: "ONLINE" })}>Online</button>
                </div>
                <span className="field-hint">Lessons are online.</span>
                <input type="hidden" name="format" value={format} />
              </div>
              </div>
              <div className="search-actions">
                <button className="button">Search</button>
                <Link className="button button-outline clear-filters" href="/discover">
                  Clear filters
                </Link>
              </div>
            </fieldset>
          </form>
        </aside>
        <section className="search-results" aria-live="polite">
          <header className="search-hero">
            <h1>Find a tutor</h1>
          </header>
          <div className="recommend-banner">
            <strong>Recommended tutors</strong>
            {account ? (
              preferences.error ? (
                <span>
                  Your learning preferences could not load. These recommendations use ratings and availability.{" "}
                  <button className="text-link" onClick={() => void preferences.reload()}>Retry preferences</button>
                </span>
              ) : (
                <span>Ranked by rating and upcoming availability, with your learning areas first.</span>
              )
            ) : (
              <span>
                Ranked by rating and upcoming availability. <Link className="text-link" href="/login?returnTo=/discover">Log in</Link> to get recommendations based on your learning areas.
              </span>
            )}
          </div>
          <div className="result-bar">
            <span className="muted">{resource.data ? `${resultCount} ${resultCount === 1 ? "subject" : "subjects"} found` : ""}</span>
            <label className="sort-control">
              <span>Sort</span>
              <Dropdown
                id="sort"
                name="sort"
                defaultValue={query.get("sort") ?? "RECOMMENDED"}
                onValueChange={(value) => apply({ sort: value === "RECOMMENDED" ? null : value })}
                options={[
                  { value: "RECOMMENDED", label: "Recommended" },
                  { value: "PRICE_ASC", label: "Price: low to high" },
                  { value: "PRICE_DESC", label: "Price: high to low" },
                  { value: "TOP_RATED", label: "Top rated" },
                ]}
              />
            </label>
          </div>
          <ResourceState
            loading={!ready || resource.loading || Boolean(account && preferences.loading)}
            error={searchDown ? "" : resource.error}
            failure={resource.failure}
            retry={() => void resource.reload()}
          />
          {resource.data && !resource.loading && (
            <>
              {resource.data.items.length === 0 && (
                <div className="empty-state">
                  <h2>No tutors match these filters</h2>
                  <p>Try a different search, or clear the filters.</p>
                </div>
              )}
              <div className="account-grid">
            {resource.data.items.map((item) => (
              <article className="panel tutor-card" key={item.subject.id}>
                <h2>
                  <Link href={`/tutors/${item.subject.tutorId}/subjects/${item.subject.id}`}>
                    {item.subject.name}
                  </Link>
                </h2>
                <p className="tutor-card-by">
                  <Link href={`/tutors/${item.subject.tutorId}`}>{item.tutorDisplayName}</Link>
                  <VerifiedBadge />
                </p>
                <p className="tutor-card-meta">
                  Online · {item.subject.learningAreas.join(", ")}
                </p>
                <p className="tutor-card-desc">{item.subject.description}</p>
                <div className="stat-line">
                  <strong>THB {item.subject.hourlyRate}/hour</strong>
                  <RatingLabel
                    average={item.rating.average}
                    count={item.rating.reviewCount}
                  />
                </div>
                <p className="tutor-card-meta">
                  Next available:{" "}
                  {item.nextAvailableAt
                    ? `${bangkokTime(item.nextAvailableAt)} (Bangkok)`
                    : "No future free slots"}
                </p>
              </article>
            ))}
          </div>
              <Pager pagination={resource.data.pagination} onPage={navigate} />
            </>
          )}
        </section>
      </div>
    </>
  );
}
export function TutorProfile({ tutorId }: { tutorId: string }) {
  const resource = useResource<PublicTutor>(
    `/discovery/tutors/${encodeURIComponent(tutorId)}/profile`,
    false,
  );
  const tutor = resource.data;
  return (
    <>
      <Link className="text-link" href="/discover">
        Back to discovery
      </Link>
      {!tutor && <h1 className="page-title">Tutor profile</h1>}
      <ResourceState
        loading={resource.loading}
        error={resource.error}
        failure={resource.failure}
        retry={() => void resource.reload()}
        backHref="/discover"
        backLabel="Find tutors"
      />
      {tutor && (
        <>
          <section className="panel">
            <p className="eyebrow">VERIFIED TUTOR</p>
            <h1>{tutor.displayName}</h1>
            <h2>{tutor.headline}</h2>
            <p style={{ whiteSpace: "pre-wrap" }}>{tutor.bio}</p>
            {tutor.introVideoUrl && (
              <a
                className="text-link"
                href={tutor.introVideoUrl}
                rel="noreferrer"
                target="_blank"
              >
                Watch introduction video
              </a>
            )}
          </section>
          <h2>Online subjects</h2>
          {tutor.subjects.length === 0 && <p>No subjects published yet.</p>}
          <div className="account-grid">
            {tutor.subjects.map((subject) => (
              <section className="panel" key={subject.id}>
                <h3>{subject.name}</h3>
                <p>{subject.description}</p>
                <p>THB {subject.hourlyRate}/hour</p>
                <Link
                  className="button"
                  href={`/tutors/${tutor.id}/subjects/${subject.id}`}
                >
                  View availability
                </Link>
              </section>
            ))}
          </div>
          <ReviewList tutorId={tutor.id} />
        </>
      )}
    </>
  );
}
function selectionError(slots: Slot[]): string | null {
  if (slots.length === 0) return "Choose at least one slot.";
  if (slots.length > 8) return "Choose at most eight half-hour slots.";
  const ordered = [...slots].sort((a, b) =>
    a.startsAt.localeCompare(b.startsAt),
  );
  if (
    ordered.some(
      (slot, index) =>
        new Date(slot.startsAt).getTime() <= Date.now() ||
        new Date(slot.endsAt).getTime() - new Date(slot.startsAt).getTime() !==
          30 * 60 * 1000 ||
        (index > 0 && ordered[index - 1].endsAt !== slot.startsAt),
    )
  )
    return "Choose consecutive future half-hour slots on this day.";
  return null;
}
export function SubjectDetails({
  tutorId,
  subjectId,
}: {
  tutorId: string;
  subjectId: string;
}) {
  const { account } = useAuth();
  const [date, setDate] = useState(bangkokDate);
  const [selected, setSelected] = useState<string[]>([]);
  const resource = useResource<SubjectPageData>(
    `/discovery/tutors/${encodeURIComponent(tutorId)}/subjects/${encodeURIComponent(subjectId)}?date=${date}`,
    false,
  );
  const data = resource.data;
  useEffect(() => {
    setSelected([]);
  }, [date]);
  const selectedSlots =
    data?.slots.filter((slot) => selected.includes(slot.id)) ?? [];
  const error = selectionError(selectedSlots);
  const firstSlot = [...selectedSlots].sort((a, b) => a.startsAt.localeCompare(b.startsAt))[0];
  const selectionQuery = new URLSearchParams({
    tutorId,
    subjectId,
    // The booking page re-reads this subject's slots for the same Bangkok day, so the day travels with the selection.
    ...(firstSlot ? { date: new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok" }).format(new Date(firstSlot.startsAt)) } : {}),
    slotIds: [...selectedSlots]
      .sort((a, b) => a.startsAt.localeCompare(b.startsAt))
      .map((slot) => slot.id)
      .join(","),
  });
  const bookingPath = `/bookings/new?${selectionQuery}`;
  return (
    <>
      <Link className="text-link" href={`/tutors/${tutorId}`}>
        Back to tutor profile
      </Link>
      {!data && <h1 className="page-title">Subject details</h1>}
      <ResourceState
        loading={resource.loading}
        error={resource.error}
        failure={resource.failure}
        retry={() => void resource.reload()}
        backHref={`/tutors/${tutorId}`}
        backLabel="Back to tutor profile"
      />
      {data && (
        <>
          <section className="panel">
            <p className="eyebrow">ONLINE LESSON</p>
            <h1>{data.subject.name}</h1>
            <p>
              With{" "}
              <Link className="text-link" href={`/tutors/${data.tutor.id}`}>
                {data.tutor.displayName}
              </Link>
            </p>
            <p style={{ whiteSpace: "pre-wrap" }}>{data.subject.description}</p>
            <div className="stat-line">
              <strong>THB {data.subject.hourlyRate}/hour</strong>
              <RatingLabel
                average={data.rating.average}
                count={data.rating.reviewCount}
              />
            </div>
            <p>{data.subject.learningAreas.join(", ")}</p>
          </section>
          <section className="panel">
            <h2>Choose your lesson time</h2>
            <p>
              Select 1 to 8 consecutive half-hour slots. All times use
              Asia/Bangkok.
            </p>
            <Field
              id="lesson-date"
              label="Lesson date (Bangkok)"
              type="date"
              min={bangkokDate()}
              value={date}
              onChange={(event) => {
                if (event.target.value) setDate(event.target.value);
              }}
            />
            {data.slots.length === 0 && (
              <p className="empty-state">No free slots on this date.</p>
            )}
            <fieldset className="field">
              <legend>Available half-hour slots</legend>
              {data.slots.map((slot) => (
                <label key={slot.id} className="check-row">
                  <input
                    type="checkbox"
                    checked={selected.includes(slot.id)}
                    disabled={new Date(slot.startsAt).getTime() <= Date.now()}
                    onChange={(event) =>
                      setSelected((previous) =>
                        event.target.checked
                          ? [...previous, slot.id]
                          : previous.filter((id) => id !== slot.id),
                      )
                    }
                  />
                  <span>
                    {bangkokTime(slot.startsAt)} to{" "}
                    {new Intl.DateTimeFormat("en-GB", {
                      timeZone: "Asia/Bangkok",
                      timeStyle: "short",
                    }).format(new Date(slot.endsAt))}
                  </span>
                </label>
              ))}
            </fieldset>
            <p>
              {selectedSlots.length} slots selected, {selectedSlots.length / 2}{" "}
              hours.
            </p>
            {selectedSlots.length > 0 && error && (
              <Notice kind="error">{error}</Notice>
            )}
            {account?.id === data.subject.tutorUserId ? (
              <Notice kind="info">You cannot book your own subject.</Notice>
            ) : (
              !error && (
                <Link
                  className="button"
                  href={
                    account
                      ? bookingPath
                      : `/login?returnTo=${encodeURIComponent(bookingPath)}`
                  }
                >
                  {account ? "Continue to booking" : "Sign in and continue"}
                </Link>
              )
            )}
            <p className="muted">
              Your booking summary will show the final price and learning-goal
              note before a hold is created. Selecting slots here does not
              reserve them.
            </p>
          </section>
          <section className="panel">
            <h2>Rating breakdown</h2>
            {([5, 4, 3, 2, 1] as const).map((rating) => (
              <p key={rating}>
                {rating} stars:{" "}
                {
                  data.rating.distribution[
                    String(rating) as keyof typeof data.rating.distribution
                  ]
                }
              </p>
            ))}
          </section>
          <ReviewList tutorId={tutorId} subjectId={subjectId} />
        </>
      )}
    </>
  );
}
