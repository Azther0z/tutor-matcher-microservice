"use client";

import { useState } from "react";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function pad(value: number) {
  return String(value).padStart(2, "0");
}
function key(year: number, month: number, day: number) {
  return `${year}-${pad(month + 1)}-${pad(day)}`;
}
function addDays(date: string, days: number) {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** Month grid for choosing a lesson day. Days before `min` or after `max` (YYYY-MM-DD) are disabled. */
export function LessonCalendar({
  value,
  min,
  maxDays = 92,
  onChange,
}: {
  value: string;
  min: string;
  maxDays?: number;
  onChange: (date: string) => void;
}) {
  const max = addDays(min, maxDays);
  const [shown, setShown] = useState(() => {
    const [y, m] = value.split("-").map(Number);
    return { year: y, month: m - 1 };
  });
  const first = new Date(Date.UTC(shown.year, shown.month, 1));
  const lead = (first.getUTCDay() + 6) % 7;
  const count = new Date(Date.UTC(shown.year, shown.month + 1, 0)).getUTCDate();
  const cells: (number | null)[] = [
    ...Array<null>(lead).fill(null),
    ...Array.from({ length: count }, (_, i) => i + 1),
  ];
  const step = (by: number) =>
    setShown(({ year, month }) => {
      const next = new Date(Date.UTC(year, month + by, 1));
      return { year: next.getUTCFullYear(), month: next.getUTCMonth() };
    });
  const prevDisabled = key(shown.year, shown.month, 1) <= min.slice(0, 8) + "01";
  const nextDisabled = key(shown.year, shown.month + 1, 1) > max;
  return (
    <div className="lesson-calendar">
      <div className="lesson-calendar-head">
        <strong>
          {MONTHS[shown.month]} {shown.year}
        </strong>
        <span className="lesson-calendar-nav">
          <button type="button" aria-label="Previous month" disabled={prevDisabled} onClick={() => step(-1)}>
            ‹
          </button>
          <button type="button" aria-label="Next month" disabled={nextDisabled} onClick={() => step(1)}>
            ›
          </button>
        </span>
      </div>
      <div className="lesson-calendar-grid" role="grid">
        {WEEKDAYS.map((day) => (
          <span key={day} className="lesson-calendar-weekday" role="columnheader">
            {day}
          </span>
        ))}
        {cells.map((day, index) => {
          if (day === null) return <span key={`blank-${index}`} />;
          const date = key(shown.year, shown.month, day);
          const disabled = date < min || date > max;
          return (
            <button
              type="button"
              key={date}
              className={`lesson-calendar-day${date === min ? " is-today" : ""}`}
              aria-pressed={date === value}
              aria-label={date}
              disabled={disabled}
              onClick={() => onChange(date)}
            >
              {day}
            </button>
          );
        })}
      </div>
    </div>
  );
}
