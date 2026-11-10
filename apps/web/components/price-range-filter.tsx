"use client";

import { useState } from "react";

const CAP = 3000;
const STEP = 50;

const toNumber = (text: string, fallback: number) => {
  const parsed = Number(text);
  return text.trim() !== "" && Number.isFinite(parsed) ? parsed : fallback;
};

/**
 * Price per hour: a two-handle slider up to 3000 plus two typed fields. The fields are the real form values
 * (minRate and maxRate), so a higher maximum can be typed; an empty maximum means no upper limit.
 */
export function PriceRangeFilter({ defaultMin, defaultMax, minError, maxError }: { defaultMin: string; defaultMax: string; minError?: string; maxError?: string }) {
  const [min, setMin] = useState(defaultMin);
  const [max, setMax] = useState(defaultMax);
  const low = Math.min(toNumber(min, 0), CAP);
  const high = Math.min(toNumber(max, CAP), CAP);
  return (
    <div className="price-range" role="group" aria-labelledby="price-label">
      <span className="field-label" id="price-label">Price per hour (THB)</span>
      <div className="range-slider" style={{ "--lo": low / CAP, "--hi": high / CAP } as React.CSSProperties}>
        <div className="range-track" />
        <div className="range-fill" />
        <input
          type="range"
          min={0}
          max={CAP}
          step={STEP}
          value={low}
          aria-label="Minimum price"
          style={{ zIndex: low > CAP / 2 ? 3 : 1 }}
          onChange={(event) => {
            const next = Math.min(Number(event.target.value), Math.max(0, high - STEP));
            setMin(next === 0 ? "" : String(next));
          }}
        />
        <input
          type="range"
          min={0}
          max={CAP}
          step={STEP}
          value={high}
          aria-label="Maximum price"
          style={{ zIndex: 2 }}
          onChange={(event) => {
            const next = Math.max(Number(event.target.value), Math.min(CAP, low + STEP));
            setMax(next >= CAP ? "" : String(next));
          }}
        />
      </div>
      <div className="price-inputs">
        <div className="field">
          <label htmlFor="minimum-rate">Min</label>
          <input id="minimum-rate" name="minRate" inputMode="decimal" placeholder="0" value={min} aria-invalid={Boolean(minError)} onChange={(event) => setMin(event.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="maximum-rate">Max</label>
          <input id="maximum-rate" name="maxRate" inputMode="decimal" placeholder={`${CAP}+`} value={max} aria-invalid={Boolean(maxError)} onChange={(event) => setMax(event.target.value)} />
        </div>
      </div>
      {minError && <span className="field-error">{minError}</span>}
      {maxError && <span className="field-error">{maxError}</span>}
    </div>
  );
}
