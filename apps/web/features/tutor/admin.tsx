"use client";

import Link from "next/link";
import { StatusBadge } from "@/features/wallet/common";
import { useState } from "react";
import { RequireAuth } from "@/lib/auth-context";
import { Field, Notice } from "@/components/field";
import { Dropdown } from "@/components/dropdown";
import { LegalModal } from "@/components/legal-modal";
import {
  ActionMessages,
  bangkokTime,
  Pager,
  ResourceState,
  useAction,
  useResource,
} from "./common";
import type { Page, Submission } from "./types";

const STATUS_OPTIONS = [
  { value: "PENDING", label: "Pending" },
  { value: "APPROVED", label: "Approved" },
  { value: "REJECTED", label: "Rejected" },
  { value: "CANCELLED", label: "Cancelled" },
  { value: "ALL", label: "All" },
];
function QueueContent() {
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState("PENDING");
  const resource = useResource<Page<Submission>>(
    `/admin/tutor-requests?status=${status}&page=${page}&pageSize=20`,
  );
  return (
    <>
      <header className="page-heading page-heading-row">
        <h1>Tutor requests</h1>
        <div className="tx-filter">
          <Dropdown
            id="request-status"
            value={status}
            onValueChange={(value) => {
              setPage(1);
              setStatus(value);
            }}
            options={STATUS_OPTIONS}
          />
        </div>
      </header>
      <ResourceState
        loading={resource.loading}
        error={resource.error}
        retry={() => void resource.reload()}
      />
      {resource.data && (
        <>
          {resource.data.items.length === 0 && (
            <p className="tutor-card-meta">No requests in this queue.</p>
          )}
          <div className="tx-list">
            {[...resource.data.items]
              .sort((a, b) => (b.submittedAt ?? "").localeCompare(a.submittedAt ?? ""))
              .map((item) => (
              <Link
                key={item.id}
                className="panel tutor-card tx-card"
                href={`/admin/tutor-requests/${item.id}`}
              >
                <span>
                  <strong>{item.headline || "Tutor profile"}</strong>
                  <small>
                    {item.kind === "APPLICATION" ? "Application" : "Profile revision"}
                    {item.submittedAt ? `, ${bangkokTime(item.submittedAt)}` : ""}
                  </small>
                </span>
                <StatusBadge value={item.state} />
              </Link>
            ))}
          </div>
          <Pager pagination={resource.data.pagination} onPage={setPage} />
        </>
      )}
    </>
  );
}
function DetailContent({ submissionId }: { submissionId: string }) {
  const resource = useResource<Submission>(
    `/admin/tutor-requests/${encodeURIComponent(submissionId)}`,
  );
  const action = useAction(async () => {
    await resource.reload();
    setOpen(false);
  });
  const [decision, setDecision] = useState("APPROVE");
  const [open, setOpen] = useState(false);
  const submission = resource.data;
  async function review(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!submission) return;
    const reason = String(
      new FormData(event.currentTarget).get("reason") ?? "",
    ).trim();
    await action.run(
      `/admin/tutor-requests/${submission.id}/review`,
      { decision, ...(reason ? { reason } : {}) },
      "POST",
      submission.revision,
    );
  }
  return (
    <>
      <header className="page-heading">
        <h1>Tutor request</h1>
      </header>
      <ResourceState
        loading={resource.loading}
        error={resource.error}
        retry={() => void resource.reload()}
      />
      {submission && (
        <section className="panel booking-new submission-card">
          <StatusBadge value={submission.state} corner />
          <div className="booking-title">
            <h2>{submission.headline || "Tutor profile"}</h2>
            <p className="tutor-card-meta">
              {submission.kind === "APPLICATION" ? "Application" : "Profile revision"}
            </p>
          </div>
          {submission.bio && <p className="submission-bio full">{submission.bio}</p>}
          <div className="summary-rows">
            <div>
              <span>Applicant account</span>
              <strong className="mono-id">{submission.userId}</strong>
            </div>
            <div>
              <span>Activation</span>
              <strong>{submission.activation.charAt(0) + submission.activation.slice(1).toLowerCase()}</strong>
            </div>
            {submission.submittedAt && (
              <div>
                <span>Submitted</span>
                <strong>{bangkokTime(submission.submittedAt)}</strong>
              </div>
            )}
            {submission.identificationDocumentUrl && (
              <div>
                <span>Identification document</span>
                <a href={submission.identificationDocumentUrl} rel="noreferrer" target="_blank">Open</a>
              </div>
            )}
            {submission.introVideoUrl && (
              <div>
                <span>Introduction video</span>
                <a href={submission.introVideoUrl} rel="noreferrer" target="_blank">Open</a>
              </div>
            )}
          </div>
          {submission.rejectionReason && (
            <Notice kind="error">{submission.rejectionReason}</Notice>
          )}
          {!open && action.error && (
            <Notice kind="error" requestId={action.requestId}>
              {action.error}
            </Notice>
          )}
          <div className="slot-footer flush">
            <button
              className="button button-quiet"
              onClick={() => void resource.reload()}
            >
              Refresh
            </button>
            {submission.state === "PENDING" && (
              <button className="button" onClick={() => setOpen(true)}>
                Review
              </button>
            )}
          </div>
        </section>
      )}
      {submission && (
        <LegalModal
          open={open}
          title="Review request"
          onClose={() => setOpen(false)}
          actions={
            <div className="button-row" style={{ justifyContent: "flex-end" }}>
              <button type="button" className="button button-quiet" onClick={() => setOpen(false)}>
                Cancel
              </button>
              <button
                type="submit"
                form="review-form"
                className="button"
                disabled={action.pending || action.uncertain}
              >
                {action.pending ? "Saving..." : "Save decision"}
              </button>
            </div>
          }
        >
          <form id="review-form" className="topup-step" onSubmit={(event) => void review(event)}>
            <ActionMessages action={action} />
            <div className="field">
              <span className="field-label">Decision</span>
              <div className="topup-quick" role="group" aria-label="Decision">
                {[
                  { value: "APPROVE", label: "Approve" },
                  { value: "REJECT", label: "Reject" },
                ].map((item) => (
                  <button
                    type="button"
                    key={item.value}
                    className="topup-chip"
                    aria-pressed={decision === item.value}
                    onClick={() => setDecision(item.value)}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </div>
            <Field
              id="reason"
              label={decision === "REJECT" ? "Reason (required)" : "Reason (optional)"}
              required={decision === "REJECT"}
              maxLength={2000}
            />
            <p className="tutor-card-meta">
              First approval creates an unpublished listing. A revision
              replaces the approved content and keeps the publication status.
            </p>
          </form>
        </LegalModal>
      )}
    </>
  );
}
export function TutorRequestQueue() {
  return (
    <RequireAuth admin>
      <QueueContent />
    </RequireAuth>
  );
}
export function TutorRequestDetail({ submissionId }: { submissionId: string }) {
  return (
    <RequireAuth admin>
      <DetailContent submissionId={submissionId} />
    </RequireAuth>
  );
}
