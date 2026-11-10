import type { InputHTMLAttributes } from "react";

export function Field({ label, id, error, ...props }: InputHTMLAttributes<HTMLInputElement> & { label: string; id: string; error?: string }) {
  return <div className="field"><label htmlFor={id}>{label}</label><input id={id} name={id} aria-invalid={Boolean(error)} aria-describedby={error ? `${id}-error` : undefined} {...props} />{error && <span className="field-error" id={`${id}-error`}>{error}</span>}</div>;
}

export function Notice({ children, kind = "info" }: { children: React.ReactNode; kind?: "info" | "error" | "success" }) {
  return <div className={`notice notice-${kind}`} role={kind === "error" ? "alert" : "status"}>{children}</div>;
}
