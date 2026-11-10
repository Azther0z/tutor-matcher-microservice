"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Field, Notice } from "@/components/field";
import { RequireCapability } from "@/features/wallet/common";
import { api, apiResponse, errorMessage, newIdempotencyKey } from "@/lib/api";
import {
  bangkokDate,
  bangkokTime,
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
  const [notice, setNotice] = useState("");
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
    setNotice("");
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
      setNotice(`${time} is now ${opening ? "open" : "closed"}.`);
      await load();
    } catch (caught) {
      setError(errorMessage(caught, `We couldn’t update the ${time} slot.`));
    } finally {
      setPendingTime("");
    }
  }
  return (
    <>
      <TutorNavigation />
      <header className="section-heading">
        <h1>Availability</h1>
        <p>
          Open half-hour lesson slots in Bangkok time and choose which published
          subjects can use them.
        </p>
      </header>
      <section className="panel">
        <div className="field-set">
          <Field
            id="availability-date"
            label="Date (Bangkok)"
            type="date"
            min={bangkokDate()}
            value={date}
            onChange={(event) =>
              event.target.value && setDate(event.target.value)
            }
          />
          <fieldset className="field option-picker">
            <legend>Subjects for newly opened slots</legend>
            {subjects.length === 0 && !loading && (
              <p className="muted">
                Publish a subject before opening availability.
              </p>
            )}
            {subjects.map((subject) => (
              <label className="check-row" key={subject.id}>
                <input
                  type="checkbox"
                  checked={subjectIds.includes(subject.id)}
                  onChange={(event) =>
                    setSubjectIds((current) =>
                      event.target.checked
                        ? [...current, subject.id]
                        : current.filter((id) => id !== subject.id),
                    )
                  }
                />
                <span>{subject.name}</span>
              </label>
            ))}
          </fieldset>
        </div>
        {error && day && <Notice kind="error">{error}</Notice>}
        {notice && <Notice kind="success">{notice}</Notice>}
        <ResourceState
          loading={loading}
          error={!loading && !day ? error : ""}
          retry={() => void load()}
        />
        {day && (
          <div className="slot-grid" aria-label={`Availability for ${date}`}>
            {times.map((time) => {
              const slot = slots.get(time);
              const locked = slot?.state === "HELD" || slot?.state === "BOOKED";
              const open = slot?.state === "OPEN";
              return (
                <button
                  key={time}
                  type="button"
                  className={`slot-button ${open ? "open" : ""} ${locked ? "locked" : ""}`}
                  disabled={Boolean(locked || pendingTime)}
                  onClick={() => void toggle(time)}
                  aria-pressed={open}
                >
                  {time}
                  <span>
                    {locked
                      ? slot?.state.toLowerCase()
                      : open
                        ? "open"
                        : "closed"}
                  </span>
                </button>
              );
            })}
          </div>
        )}
        <p className="muted">
          Held or booked slots are locked so an existing booking cannot be
          changed accidentally.{" "}
          {day?.slots[0] &&
            `Example time: ${bangkokTime(day.slots[0].startsAt)}.`}
        </p>
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
