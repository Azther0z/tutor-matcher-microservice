"use client";

import { useState } from "react";
import { StatusBadge } from "@/features/wallet/common";
import { RequireAuth } from "@/lib/auth-context";
import { Field, Notice } from "@/components/field";
import { LegalModal } from "@/components/legal-modal";
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
  const action = useAction(async () => {
    await reload();
    setOpen(false);
  });
  const [open, setOpen] = useState(false);
  const [decision, setDecision] = useState("KEEP");
  async function decide(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await action.run(
      `/admin/reviews/${item.review.id}/moderation`,
      {
        decision,
        reason: String(form.get("reason") ?? "").trim(),
      },
      "POST",
      item.review.revision,
    );
  }
  return (
    <article className="panel booking-new submission-card">
      <StatusBadge value={item.flag.state} corner />
      <div className="booking-title">
        <h2>Reported by {item.reporterDisplayName}</h2>
        <p className="tutor-card-meta">{bangkokTime(item.flag.createdAt)}</p>
      </div>
      <p className="submission-bio full">{item.flag.reason}</p>
      <div className="summary-rows">
        <div><span>Review author</span><strong>{item.review.studentDisplayName}</strong></div>
        <div><span>Rating</span><strong>{item.review.rating} / 5</strong></div>
        <div><span>Visibility</span><strong>{item.review.visibility.charAt(0) + item.review.visibility.slice(1).toLowerCase()}</strong></div>
      </div>
      <div className="flagged-review">
        {item.review.headline && <strong>{item.review.headline}</strong>}
        <p>{item.review.text}</p>
        {item.review.reply && (
          <p className="tutor-card-meta">Tutor reply: {item.review.reply.text}</p>
        )}
      </div>
      {!open && action.error && (
        <Notice kind="error" requestId={action.requestId}>{action.error}</Notice>
      )}
      {item.flag.state === "OPEN" && (
        <div className="slot-footer flush">
          <span />
          <button className="button" onClick={() => setOpen(true)}>Decide</button>
        </div>
      )}
      <LegalModal
        open={open}
        title="Moderation decision"
        onClose={() => setOpen(false)}
        actions={
          <div className="button-row" style={{ justifyContent: "flex-end" }}>
            <button type="button" className="button button-quiet" onClick={() => setOpen(false)}>Cancel</button>
            <button type="submit" form={`decide-${item.flag.id}`} className="button" disabled={action.pending || action.uncertain}>
              {action.pending ? "Saving..." : "Save decision"}
            </button>
          </div>
        }
      >
        <form id={`decide-${item.flag.id}`} className="topup-step" onSubmit={(event) => void decide(event)}>
          <ActionMessages action={action} />
          <div className="field">
            <span className="field-label">Decision</span>
            <div className="topup-quick" role="group" aria-label="Decision">
              {[
                { value: "KEEP", label: "Keep public" },
                { value: "HIDE", label: "Hide" },
                { value: "REMOVE", label: "Remove" },
              ].map((choice) => (
                <button type="button" key={choice.value} className="topup-chip" aria-pressed={decision === choice.value} onClick={() => setDecision(choice.value)}>
                  {choice.label}
                </button>
              ))}
            </div>
          </div>
          <Field id={`reason-${item.flag.id}`} name="reason" label="Reason (required)" required maxLength={2000} />
          <p className="tutor-card-meta">
            Hiding or removing takes out the whole review, its reply and its
            rating. All open reports for this review are resolved together and
            the author and reporters are notified.
          </p>
        </form>
      </LegalModal>
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
      <header className="page-heading">
        <h1>Review reports</h1>
      </header>
      <ResourceState
        loading={resource.loading}
        error={resource.error}
        retry={() => void resource.reload()}
      />
      {resource.data && (
        <>
          {resource.data.items.length === 0 && (
            <p className="tutor-card-meta">No review reports.</p>
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
