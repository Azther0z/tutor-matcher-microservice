"use client";

import Link from "next/link";
import { StatusBadge } from "@/features/wallet/common";
import { useState } from "react";
import { RequireAuth } from "@/lib/auth-context";
import { Field, Notice } from "@/components/field";
import { Dropdown } from "@/components/dropdown";
import {
  ActionMessages,
  bangkokTime,
  Pager,
  ResourceState,
  useAction,
  useResource,
} from "./common";
import type { Page, Submission } from "./types";

function QueueContent() {
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState("PENDING");
  const resource = useResource<Page<Submission>>(
    `/admin/tutor-requests?status=${status}&page=${page}&pageSize=20`,
  );
  return (
    <>
      <header className="section-heading">
        <h1>Tutor requests</h1>
        <p>
          Review submitted applications and profile revisions. Private documents
          stay inside this queue.
        </p>
      </header>
      <div className="field">
        <label htmlFor="request-status">Submission status</label>
        <Dropdown
          id="request-status"
          value={status}
          onValueChange={(value) => {
            setPage(1);
            setStatus(value);
          }}
          options={["PENDING", "APPROVED", "REJECTED", "CANCELLED", "ALL"].map((value) => ({ value, label: value }))}
        />
      </div>
      <ResourceState
        loading={resource.loading}
        error={resource.error}
        retry={() => void resource.reload()}
      />
      {resource.data && (
        <>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Request</th>
                  <th>Kind</th>
                  <th>Status</th>
                  <th>Submitted (Bangkok)</th>
                </tr>
              </thead>
              <tbody>
                {resource.data.items.map((item) => (
                  <tr key={item.id}>
                    <td>
                      <Link href={`/admin/tutor-requests/${item.id}`}>
                        {item.headline || item.userId}
                      </Link>
                    </td>
                    <td>{item.kind}</td>
                    <td>{item.state}</td>
                    <td>
                      {item.submittedAt
                        ? bangkokTime(item.submittedAt)
                        : "Draft"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {resource.data.items.length === 0 && (
            <p className="empty-state">No requests in this queue.</p>
          )}
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
  const action = useAction(resource.reload);
  const [decision, setDecision] = useState("APPROVE");
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
      <header className="section-heading">
        <h1>Review tutor submission</h1>
      </header>
      <ResourceState
        loading={resource.loading}
        error={resource.error}
        retry={() => void resource.reload()}
      />
      {submission && (
        <section className="panel">
          <div className="stat-line">
            <StatusBadge value={submission.state} />
            <span>{submission.kind}</span>
            <span>Activation: {submission.activation}</span>
          </div>
          <h2>{submission.headline || "Tutor profile"}</h2>
          <p>Applicant account: {submission.userId}</p>
          <p style={{ whiteSpace: "pre-wrap" }}>{submission.bio}</p>
          {submission.identificationDocumentUrl && (
            <p>
              <a
                className="text-link"
                href={submission.identificationDocumentUrl}
                rel="noreferrer"
                target="_blank"
              >
                Open private identification document
              </a>
            </p>
          )}
          {submission.introVideoUrl && (
            <p>
              <a
                className="text-link"
                href={submission.introVideoUrl}
                rel="noreferrer"
                target="_blank"
              >
                Open introduction video
              </a>
            </p>
          )}
          {submission.rejectionReason && (
            <Notice kind="error">{submission.rejectionReason}</Notice>
          )}
          {submission.activation === "PENDING" && (
            <Notice kind="info">
              Approval is saved. Auth activation is pending. The applicant
              cannot use Tutor access until it finishes.
            </Notice>
          )}
          <ActionMessages action={action} />
          {submission.state === "PENDING" && (
            <form className="form" onSubmit={(event) => void review(event)}>
              <div className="field">
                <label htmlFor="decision">Decision</label>
                <Dropdown
                  id="decision"
                  value={decision}
                  onValueChange={setDecision}
                  options={[
                    { value: "APPROVE", label: "Approve" },
                    { value: "REJECT", label: "Reject" },
                  ]}
                />
              </div>
              <Field
                id="reason"
                label="Reason (required for rejection)"
                required={decision === "REJECT"}
                maxLength={2000}
              />
              <p>
                Initial approval creates an unpublished listing. Revision
                approval replaces approved content without changing publication
                status.
              </p>
              <button
                className="button"
                disabled={action.pending || action.uncertain}
              >
                {action.pending ? "Saving decision..." : "Save review decision"}
              </button>
            </form>
          )}
          <button
            className="button button-quiet"
            onClick={() => void resource.reload()}
          >
            Refresh submission
          </button>
        </section>
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
