import type { InputHTMLAttributes } from "react";
import type { Failure } from "@/lib/api";

export function Field({ label, id, error, hint, ...props }: InputHTMLAttributes<HTMLInputElement> & { label: string; id: string; error?: string; hint?: string }) {
  const described = [hint ? `${id}-hint` : "", error ? `${id}-error` : ""].filter(Boolean).join(" ") || undefined;
  return <div className="field"><label htmlFor={id}>{label}</label><input id={id} name={id} aria-invalid={Boolean(error)} aria-describedby={described} {...props} />{hint && <span className="field-hint" id={`${id}-hint`}>{hint}</span>}{error && <span className="field-error" id={`${id}-error`}>{error}</span>}</div>;
}

export function Notice({ children, kind = "info", requestId }: { children: React.ReactNode; kind?: "info" | "error" | "success"; requestId?: string }) {
  return <div className={`notice notice-${kind}`} role={kind === "error" ? "alert" : "status"}>{children}{requestId && <small className="request-id">Reference: {requestId}</small>}</div>;
}

/** An error notice for a failed submit, with the request reference in small text. Renders nothing without a failure. */
export function ErrorNotice({ failure, onRetry }: { failure: Failure | null; onRetry?: () => void }) {
  if (!failure) return null;
  return <Notice kind="error" requestId={failure.requestId}>{failure.message}{onRetry && <> <button type="button" className="button button-quiet" onClick={onRetry}>Try again</button></>}</Notice>;
}

/**
 * The one error state for a region that failed to load. A malformed or unknown id gets a "not found" message with a
 * way back (retrying cannot help); anything else gets the message and a retry button.
 */
export function LoadError({ failure, onRetry }: { failure: Failure | null; onRetry?: () => void }) {
  if (!failure) return null;
  if (failure.missing) {
    return <Notice kind="error" requestId={failure.requestId}>We couldn’t find that record.</Notice>;
  }
  return <ErrorNotice failure={failure} onRetry={onRetry} />;
}

/** Moves keyboard focus to the first field the last submit marked invalid. Call it after the errors are rendered. */
export function focusFirstInvalid(form: HTMLFormElement | null) {
  if (!form) return;
  window.setTimeout(() => form.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus(), 0);
}
