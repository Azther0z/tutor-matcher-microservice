/**
 * A horizontal step tracker. `reached` is the index of the last finished step. While nothing has failed the next step is
 * shown in progress (pulsing ring, dashed line leading to it); when `failed` is set that next step is crossed out instead.
 */
export function ProgressStepper({
  steps,
  reached,
  failed = false,
  label,
}: {
  steps: string[];
  reached: number;
  failed?: boolean;
  label: string;
}) {
  const last = steps.length - 1;
  const live = !failed && reached < last;
  return (
    <div
      className="booking-progress"
      style={{ "--n": steps.length } as React.CSSProperties}
      role="img"
      aria-label={failed ? label : `Step ${reached + 1} of ${steps.length}: ${steps[reached]}`}
    >
      <div className="booking-progress-track" aria-hidden="true">
        <span style={{ width: `${(reached / last) * 100}%` }} />
        {live && (
          <span
            className="booking-progress-live"
            style={{ left: `${(reached / last) * 100}%`, width: `${100 / last}%` }}
          />
        )}
      </div>
      <ol aria-hidden="true">
        {steps.map((name, index) => {
          const done = index <= reached;
          const crossed = failed && index === reached + 1;
          return (
            <li key={name} className={crossed ? "is-crossed" : done ? "is-done" : live && index === reached + 1 ? "is-live" : ""}>
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
              {name}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
