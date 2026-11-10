"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Notice } from "@/components/field";
import { LessonCalendar } from "@/components/lesson-calendar";
import { RequireCapability } from "@/features/wallet/common";
import { api, apiResponse, errorMessage, newIdempotencyKey } from "@/lib/api";
import {
  bangkokDate,
  ResourceState,
  TutorNavigation,
} from "./common";
import type { Page, Subject } from "./types";

type OwnedSlot = {
  id: string;
  date: string;
  time: string;
  startsAt: string;
  endsAt: string;
  state: "OPEN" | "CLOSED" | "HELD" | "BOOKED";
  subjectIds: string[];
  revision: string;
};
type AvailabilityDay = { date: string; slots: OwnedSlot[] };

const times = Array.from(
  { length: 48 },
  (_, index) =>
    `${String(Math.floor(index / 2)).padStart(2, "0")}:${index % 2 ? "30" : "00"}`,
);

function AvailabilityWorkspace() {
  const [date, setDate] = useState(bangkokDate);
  const [day, setDay] = useState<AvailabilityDay | null>(null);
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [subjectIds, setSubjectIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [pendingTime, setPendingTime] = useState("");
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [dayResult, subjectResult] = await Promise.all([
        api<AvailabilityDay>(`/profiles/me/tutor/availability/${date}`),
        api<Page<Subject>>("/profiles/me/tutor/subjects?page=1&pageSize=100"),
      ]);
      setDay(dayResult);
      setSubjects(subjectResult.items);
      setSubjectIds((current) =>
        current.length
          ? current.filter((id) =>
              subjectResult.items.some((subject) => subject.id === id),
            )
          : subjectResult.items[0]
            ? [subjectResult.items[0].id]
            : [],
      );
    } catch (caught) {
      setDay(null);
      setError(
        errorMessage(caught, "Tutor availability is unavailable right now."),
      );
    } finally {
      setLoading(false);
    }
  }, [date]);
  useEffect(() => {
    void load();
  }, [load]);
  const slots = useMemo(
    () => new Map(day?.slots.map((slot) => [slot.time, slot]) ?? []),
    [day],
  );
  async function toggle(time: string) {
    const current = slots.get(time);
    if (current?.state === "HELD" || current?.state === "BOOKED") return;
    const opening = current?.state !== "OPEN";
    if (opening && subjectIds.length === 0) {
      setError("Choose at least one published subject before opening a slot.");
      return;
    }
    setPendingTime(time);
    setError("");
    try {
      await apiResponse<OwnedSlot>(
        `/profiles/me/tutor/availability/${date}/${encodeURIComponent(time)}`,
        {
          method: "PUT",
          body: opening ? { state: "OPEN", subjectIds } : { state: "CLOSED" },
          idempotencyKey: newIdempotencyKey(),
          ...(current
            ? { ifMatch: `"${current.revision}"` }
            : { ifNoneMatch: "*" as const }),
        },
      );
      await load();
    } catch (caught) {
      setError(errorMessage(caught, `We couldn’t update the ${time} slot.`));
    } finally {
      setPendingTime("");
    }
  }
  return (
    <>
      <header className="page-heading"><h1>Availability</h1></header>
      <TutorNavigation />
      <section className="panel slot-panel">
        <div className="slot-layout">
          <div className="slot-col">
            <h2>Pick a date</h2>
            <LessonCalendar value={date} min={bangkokDate()} onChange={setDate} />
            <h2 className="slot-subjects-title">Subjects for opened slots</h2>
            {subjects.length === 0 && !loading && (
              <p className="tutor-card-meta">Publish a subject before opening availability.</p>
            )}
            <div className="topup-quick" role="group" aria-label="Subjects for newly opened slots">
              {subjects.map((subject) => (
                <button
                  type="button"
                  key={subject.id}
                  className="topup-chip"
                  aria-pressed={subjectIds.includes(subject.id)}
                  onClick={() =>
                    setSubjectIds((current) =>
                      current.includes(subject.id)
                        ? current.filter((id) => id !== subject.id)
                        : [...current, subject.id],
                    )
                  }
                >
                  {subject.name}
                </button>
              ))}
            </div>
          </div>
          <div className="slot-col">
            <h2>Click a time to open or close it</h2>
            <p className="tutor-card-meta">Half-hour slots, Asia/Bangkok. Held and booked slots are locked.</p>
            {error && day && <Notice kind="error">{error}</Notice>}
            <ResourceState
              loading={loading && !day}
              error={!loading && !day ? error : ""}
              retry={() => void load()}
            />
            {day && (
              <div className={`slot-grid${loading ? " is-loading" : ""}`} role="group" aria-label={`Availability for ${date}`}>
                {times.map((time) => {
                  const slot = slots.get(time);
                  const locked = slot?.state === "HELD" || slot?.state === "BOOKED";
                  const open = slot?.state === "OPEN";
                  const chip = (
                    <button
                      key={time}
                      type="button"
                      className={`slot-chip${locked ? ` slot-own ${slot?.state === "HELD" ? "is-held" : "is-booked"}` : ""}`}
                      disabled={Boolean(pendingTime) && !locked}
                      aria-disabled={locked || undefined}
                      onClick={() => !locked && void toggle(time)}
                      aria-pressed={open}
                    >
                      {time}
                    </button>
                  );
                  return locked ? (
                    <span key={time} className="tooltip-wrap" data-tip={slot?.state === "HELD" ? "Held" : "Booked"}>
                      {chip}
                    </span>
                  ) : (
                    chip
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </section>
    </>
  );
}

export function AvailabilityPage() {
  return (
    <RequireCapability capability="TUTOR">
      <AvailabilityWorkspace />
    </RequireCapability>
  );
}
