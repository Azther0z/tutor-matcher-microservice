"use client";

import { useState } from "react";

const STARS = [1, 2, 3, 4, 5];

/** Minimum rating picker: every star has a left and a right half, hovering previews everything up to that point. */
export function StarRatingFilter({ value, labelId, onChange }: { value: number; labelId: string; onChange: (next: number | null) => void }) {
  const [hover, setHover] = useState<number | null>(null);
  const shown = hover ?? value;
  const fill = (star: number) => `${Math.max(0, Math.min(1, shown - (star - 1))) * 100}%`;
  const pick = (next: number) => onChange(value === next ? null : next);
  return (
    <>
      <div className="star-filter" role="group" aria-labelledby={labelId} onMouseLeave={() => setHover(null)}>
        {STARS.map((star) => (
          <span className="star-cell" key={star}>
            <span className="star-glyph star-base" aria-hidden="true">★</span>
            <span className="star-glyph star-fill" aria-hidden="true" style={{ width: fill(star) }}>★</span>
            {/* The API accepts 1 to 5 in half steps, so the first star has no half: its whole width means 1. */}
            {(star === 1 ? [1] : [star - 0.5, star]).map((half) => (
              <button
                key={half}
                type="button"
                className={`star-hit ${star === 1 ? "star-hit-whole" : half === star ? "star-hit-right" : "star-hit-left"}`}
                aria-label={`${half} stars and up`}
                aria-pressed={value === half}
                onMouseEnter={() => setHover(half)}
                onFocus={() => setHover(half)}
                onBlur={() => setHover(null)}
                onClick={() => pick(half)}
              />
            ))}
          </span>
        ))}
      </div>
      <span className="field-hint">{shown ? `${shown} stars & up` : "Any rating"}</span>
    </>
  );
}
