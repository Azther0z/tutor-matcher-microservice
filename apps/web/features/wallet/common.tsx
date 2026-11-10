"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { RequireAuth, useAuth } from "@/lib/auth-context";
import { api } from "@/lib/api";
import type { Capability } from "@/lib/types";
import type { OperationRef, PageMeta } from "./types";
import { publicPath, titleCase } from "./format";

/** Requires a signed-in account that currently holds the capability. The backend enforces it again on every call. */
export function RequireCapability({ capability, children }: { capability: Capability; children: React.ReactNode }) {
  return <RequireAuth><CapabilityGate capability={capability}>{children}</CapabilityGate></RequireAuth>;
}

function CapabilityGate({ capability, children }: { capability: Capability; children: React.ReactNode }) {
  const { account } = useAuth();
  if (account && !account.capabilities.includes(capability)) {
    return <section className="panel"><h1>{titleCase(capability)} access required</h1><p>Your current account does not have the {capability} capability.</p>{capability === "TUTOR" && <p><Link className="button" href="/teach/application">Apply to become a tutor</Link></p>}</section>;
  }
  return <>{children}</>;
}

const STATUS_TONE: Record<string, string> = {
  PAYMENT_DUE: "due",
  PENDING: "due", UNKNOWN: "due", OPEN: "due", SKIPPED: "muted",
  CONFIRMED: "info",
  COMPLETED: "good", SUCCEEDED: "good", APPROVED: "good", DELIVERED: "good", ACTIVE: "good", IN: "good",
  CANCELLED: "bad", FAILED: "bad", REJECTED: "bad", OUT: "muted",
};
export function StatusBadge({ value, corner }: { value: string; corner?: boolean }) {
  return (
    <span className={`status-text status-${STATUS_TONE[value] ?? "muted"}${corner ? " status-corner" : ""}`}>
      {titleCase(value)}
    </span>
  );
}

export function Pager({ meta, onPage, disabled }: { meta: PageMeta; onPage: (page: number) => void; disabled?: boolean }) {
  if (meta.totalPages <= 1) return null;
  return (
    <nav className="pagination" aria-label="Pagination">
      <button className="button button-quiet" disabled={disabled || meta.page <= 1} onClick={() => onPage(meta.page - 1)}>Previous</button>
      <span>Page {meta.page} of {meta.totalPages}</span>
      <button className="button button-quiet" disabled={disabled || meta.page >= meta.totalPages} onClick={() => onPage(meta.page + 1)}>Next</button>
    </nav>
  );
}

export function DemoBanner() {
  return <p className="notice notice-info" role="note">Demonstration only. No real money moves and nothing here can be paid with a real banking app.</p>;
}

/**
 * Follows an owner operation until it leaves PENDING (the shared operation-status contract). Calls `onSettled`
 * once with the final status so the page can reload the resource. Stops after about a minute and reports it.
 */
export function useOperation(operation: OperationRef | undefined, onSettled: (status: OperationRef["status"]) => void) {
  const [state, setState] = useState<{ status: OperationRef["status"] | "TIMEOUT"; error?: string } | null>(null);
  const settled = useRef(onSettled);
  settled.current = onSettled;
  const id = operation?.id;
  const pending = operation?.status === "PENDING";
  const statusUrl = operation?.statusUrl;
  useEffect(() => {
    if (!id || !pending || !statusUrl) return;
    let cancelled = false;
    let attempts = 0;
    const tick = async () => {
      if (cancelled) return;
      attempts += 1;
      try {
        const current = await api<OperationRef>(publicPath(statusUrl));
        if (cancelled) return;
        if (current.status !== "PENDING") { setState({ status: current.status }); settled.current(current.status); return; }
        setState({ status: "PENDING" });
      } catch {
        if (cancelled) return;
        setState({ status: "PENDING", error: "We couldn’t check the status just now. Retrying…" });
      }
      if (attempts >= 30) { setState({ status: "TIMEOUT" }); return; }
      timer = setTimeout(tick, 2000);
    };
    let timer = setTimeout(tick, 1000);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [id, pending, statusUrl]);
  return state;
}
