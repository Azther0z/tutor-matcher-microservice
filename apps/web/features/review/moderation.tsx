"use client";

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
} from "../tutor/common";
import type { Page } from "../tutor/types";
import type { AdminFlag } from "./types";

function FlagCard({
  item,
  reload,
}: {
  item: AdminFlag;
  reload: () => Promise<void>;
}) {
  const action = useAction(reload);
  async function decide(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await action.run(
      `/admin/reviews/${item.review.id}/moderation`,
      {
        decision: String(form.get("decision")),
        reason: String(form.get("reason") ?? "").trim(),
      },
      "POST",
      item.review.revision,
    );
  }
  return (
    <article className="panel">
      <div className="stat-line">
        <strong>Reported by {item.reporterDisplayName}</strong>
        <span className="badge">{item.flag.state}</span>
        <time dateTime={item.flag.createdAt}>
          {bangkokTime(item.flag.createdAt)} (Bangkok)
        </time>
      </div>
      <p>Reporter account: {item.flag.reporterUserId}</p>
      <h3>Report reason</h3>
      <p style={{ whiteSpace: "pre-wrap" }}>{item.flag.reason}</p>
      <hr className="divider" />
      <h3>Flagged review</h3>
      <p>
        Author: {item.review.studentDisplayName}. Rating: {item.review.rating}
        /5. Visibility: <strong>{item.review.visibility}</strong>.
      </p>
      {item.review.headline && <h3>{item.review.headline}</h3>}
      <p style={{ whiteSpace: "pre-wrap" }}>{item.review.text}</p>
      {item.review.reply && (
        <blockquote>
          <strong>Tutor reply</strong>
          <p style={{ whiteSpace: "pre-wrap" }}>{item.review.reply.text}</p>
        </blockquote>
      )}
      <p>
        Review ID: {item.review.id}. Booking: {item.review.bookingId}.
      </p>
      <ActionMessages action={action} />
      {item.flag.state === "OPEN" && (
        <form className="form" onSubmit={(event) => void decide(event)}>
          <div className="field">
            <label htmlFor={`decision-${item.flag.id}`}>
              Moderation decision
            </label>
            <Dropdown id={`decision-${item.flag.id}`} name="decision" options={[
              { value: "KEEP", label: "Keep review public" },
              { value: "HIDE", label: "Hide whole review and reply" },
              { value: "REMOVE", label: "Remove whole review and reply" },
            ]} />
          </div>
          <Field
            id={`reason-${item.flag.id}`}
            name="reason"
            label="Moderation reason"
            required
            maxLength={2000}
          />
          <Notice kind="info">
            Hiding or removing excludes the whole review, its reply and its
            rating from public results. All open reports for this review are
            resolved together. The author and reporters are notified.
          </Notice>
          <button
            className="button"
            disabled={action.pending || action.uncertain}
          >
            Save moderation decision
          </button>
        </form>
      )}
    </article>
  );
}
function QueueContent() {
  const [page, setPage] = useState(1);
  const resource = useResource<Page<AdminFlag>>(
    `/admin/review-flags?page=${page}&pageSize=20`,
  );
  return (
    <>
      <header className="section-heading">
        <h1>Review moderation</h1>
        <p>
          Inspect the reported review and reporter details before recording a
          decision.
        </p>
      </header>
      <ResourceState
        loading={resource.loading}
        error={resource.error}
        retry={() => void resource.reload()}
      />
      {resource.data && (
        <>
          {resource.data.items.length === 0 && (
            <p className="empty-state">No review reports.</p>
          )}
          {resource.data.items.map((item) => (
            <FlagCard
              key={`${item.flag.id}:${item.review.revision}`}
              item={item}
              reload={resource.reload}
            />
          ))}
          <Pager pagination={resource.data.pagination} onPage={setPage} />
        </>
      )}
    </>
  );
}
export function ModerationQueue() {
  return (
    <RequireAuth admin>
      <QueueContent />
    </RequireAuth>
  );
}
