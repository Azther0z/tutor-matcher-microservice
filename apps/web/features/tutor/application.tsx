"use client";

import { useState } from "react";
import { StatusBadge } from "@/features/wallet/common";
import Link from "next/link";
import { RequireAuth, useAuth } from "@/lib/auth-context";
import { Field, Notice } from "@/components/field";
import { LegalModal } from "@/components/legal-modal";
import {
  ActionMessages,
  bangkokTime,
  ResourceState,
  TutorNavigation,
  useAction,
  useResource,
} from "./common";
import type { Submission, Workspace } from "./types";

function draftBody(form: FormData) {
  return {
    headline: String(form.get("headline") ?? "").trim(),
    bio: String(form.get("bio") ?? "").trim(),
    identificationDocumentUrl:
      String(form.get("identificationDocumentUrl") ?? "").trim() || null,
    introVideoUrl: String(form.get("introVideoUrl") ?? "").trim() || null,
    avatarUrl: String(form.get("avatarUrl") ?? "").trim() || null,
  };
}
function DraftEditor({
  draft,
  seed,
  reload,
  onClose,
}: {
  draft?: Submission;
  seed?: Submission;
  reload: () => Promise<void>;
  onClose: () => void;
}) {
  const value = draft ?? seed;
  const action = useAction(async () => {
    await reload();
    onClose();
  });
  const formId = `draft-form-${draft?.id ?? "new"}`;
  const save = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    await action.run(
      draft
        ? `/profiles/me/tutor/drafts/${draft.id}`
        : "/profiles/me/tutor/drafts",
      draftBody(new FormData(event.currentTarget)),
      draft ? "PUT" : "POST",
      draft?.revision,
    );
  };
  const busy = action.pending || action.uncertain;
  return (
    <LegalModal
      open
      onClose={onClose}
      title={draft ? "Edit draft" : seed ? "New profile revision" : "New tutor application"}
      actions={
        <div className="slot-footer flush">
          {draft ? (
            <button
              type="button"
              className="button button-quiet"
              disabled={busy}
              onClick={() => {
                if (window.confirm("Delete this editable draft?"))
                  void action.run(
                    `/profiles/me/tutor/drafts/${draft.id}`,
                    undefined,
                    "DELETE",
                    draft.revision,
                  );
              }}
            >
              Delete draft
            </button>
          ) : (
            <span />
          )}
          <div className="button-row">
            <button className="button" form={formId} disabled={busy}>
              {action.pending ? "Saving..." : "Save draft"}
            </button>
          </div>
        </div>
      }
    >
      <ActionMessages action={action} />
      <form id={formId} className="form" onSubmit={(event) => void save(event)}>
        <Field
          id={`headline-${draft?.id ?? "new"}`}
          name="headline"
          label="Headline"
          defaultValue={value?.headline ?? ""}
          maxLength={200}
        />
        <div className="field">
          <label htmlFor={`bio-${draft?.id ?? "new"}`}>Bio</label>
          <textarea
            id={`bio-${draft?.id ?? "new"}`}
            name="bio"
            defaultValue={value?.bio ?? ""}
            maxLength={5000}
            rows={5}
          />
        </div>
        <Field
          id={`document-${draft?.id ?? "new"}`}
          name="identificationDocumentUrl"
          label="Identification document link (private)"
          type="url"
          placeholder="https://example.test/synthetic-document"
          defaultValue={value?.identificationDocumentUrl ?? ""}
        />
        <Field
          id={`video-${draft?.id ?? "new"}`}
          name="introVideoUrl"
          label="Introduction video link"
          type="url"
          defaultValue={value?.introVideoUrl ?? ""}
        />
        <Field
          id={`avatar-${draft?.id ?? "new"}`}
          name="avatarUrl"
          label="Avatar link (optional)"
          type="url"
          defaultValue={value?.avatarUrl ?? ""}
        />
      </form>
      <p className="tutor-card-meta">
        Use HTTPS links. Only you and authorized admins can see your document.
        Drafts can be incomplete. To submit you need a bio and both links.
      </p>
    </LegalModal>
  );
}
function DraftRow({
  draft,
  reload,
  onEdit,
}: {
  draft: Submission;
  reload: () => Promise<void>;
  onEdit: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [consent, setConsent] = useState(false);
  const action = useAction(async () => {
    await reload();
    setConfirming(false);
  });
  const busy = action.pending || action.uncertain;
  return (
    <div className="draft-row">
      <strong>{draft.headline || "Untitled draft"}</strong>
      <div className="button-row">
        <button type="button" className="button button-quiet" onClick={onEdit}>
          Edit
        </button>
        <button type="button" className="button" onClick={() => setConfirming(true)}>
          Submit
        </button>
      </div>
      {confirming && (
        <LegalModal
          open
          title="Submit for review"
          onClose={() => setConfirming(false)}
          actions={
            <button
              type="button"
              className="button"
              disabled={!consent || busy}
              onClick={() =>
                void action.run(
                  `/profiles/me/tutor/drafts/${draft.id}/submit`,
                  { consentAccepted: true },
                  "POST",
                  draft.revision,
                )
              }
            >
              {action.pending ? "Submitting..." : "Submit"}
            </button>
          }
        >
          <ActionMessages action={action} />
          <p>
            You need a bio, an identification document link and an intro video
            link. Submitted versions cannot be edited.
          </p>
          <label className="check-row">
            <input
              type="checkbox"
              checked={consent}
              onChange={(event) => setConsent(event.target.checked)}
            />
            <span>
              I consent to the application review and use of my submitted
              documents.
            </span>
          </label>
        </LegalModal>
      )}
    </div>
  );
}
function SubmissionHistory({
  submission,
  reload,
}: {
  submission: Submission;
  reload: () => Promise<void>;
}) {
  const action = useAction(reload);
  return (
    <div className="history-row">
      <div className="history-main">
        <strong>{submission.headline || "Tutor profile"}</strong>
        <small>
          {submission.kind === "APPLICATION" ? "Application" : "Profile revision"}
        </small>
        {submission.submittedAt && (
          <small>Submitted {bangkokTime(submission.submittedAt)}</small>
        )}
        {submission.reviewedAt && (
          <small>Reviewed {bangkokTime(submission.reviewedAt)}</small>
        )}
        {submission.rejectionReason && (
          <small className="status-bad">Review reason: {submission.rejectionReason}</small>
        )}
        <ActionMessages action={action} />
      </div>
      <div className="history-side">
        <StatusBadge value={submission.state} />
        <span className="button-row">
          {submission.identificationDocumentUrl && (
            <a
              className="button button-quiet"
              href={submission.identificationDocumentUrl}
              rel="noreferrer"
              target="_blank"
            >
              ID document
            </a>
          )}
          {submission.state === "PENDING" && (
            <button
              className="button button-quiet"
              disabled={action.pending || action.uncertain}
              onClick={() =>
                void action.run(
                  "/profiles/me/tutor/withdraw",
                  { submissionId: submission.id },
                  "POST",
                  submission.revision,
                )
              }
            >
              Withdraw
            </button>
          )}
          {["REJECTED", "CANCELLED"].includes(submission.state) && (
            <button
              className="button button-quiet"
              disabled={action.pending || action.uncertain}
              onClick={() =>
                void action.run(
                  `/profiles/me/tutor/submissions/${submission.id}/copy`,
                )
              }
            >
              Copy into new draft
            </button>
          )}
        </span>
      </div>
    </div>
  );
}
function ApplicationContent({ profile = false }: { profile?: boolean }) {
  const resource = useResource<Workspace>("/profiles/me/tutor");
  const action = useAction(resource.reload);
  const { account, refresh } = useAuth();
  const [editing, setEditing] = useState<string | null>(null);
  const workspace = resource.data;
  const current = workspace?.approvedSubmissionId
    ? workspace.submissions.find(
        (item) => item.id === workspace.approvedSubmissionId,
      )
    : workspace?.submissions
        .filter((item) => item.state === "APPROVED")
        .sort((left, right) =>
          (right.reviewedAt ?? "").localeCompare(left.reviewedAt ?? ""),
        )[0];
  return (
    <>
      <header className="page-heading">
        <h1>{profile ? "Profile and publication" : "Tutor application"}</h1>
      </header>
      <TutorNavigation />
      <ResourceState
        loading={resource.loading}
        error={resource.error}
        retry={() => void resource.reload()}
      />
      {workspace && (
        <>
          <section className="panel booking-new">
            <h2>Your tutor status</h2>
            <div className="summary-rows">
              <div>
                <span>Activation</span>
                <strong>{workspace.activation.charAt(0) + workspace.activation.slice(1).toLowerCase()}</strong>
              </div>
              <div>
                <span>Listing</span>
                <strong>{workspace.published ? "Published" : "Unpublished"}</strong>
              </div>
            </div>
            {workspace.activation === "PENDING" && (
              <Notice kind="info">
                Your application was approved. Tutor access is still being
                activated.
              </Notice>
            )}
            {workspace.activation === "ACTIVE" &&
              !account?.capabilities.includes("TUTOR") && (
                <Notice kind="info">
                  Tutor activation finished. Refresh your account access to
                  continue.{" "}
                  <button
                    className="button button-quiet"
                    onClick={() => void refresh()}
                  >
                    Refresh access
                  </button>
                </Notice>
              )}
            <ActionMessages action={action} />
            {!workspace.published && (
              <p className="tutor-card-meta">
                Unpublished listings do not appear in search. Existing
                bookings and conversations stay available.
              </p>
            )}
            <div className="slot-footer flush">
              <div className="button-row">
                <button
                  className="button button-quiet"
                  onClick={() => void resource.reload()}
                >
                  Refresh
                </button>
                {workspace.tutorId &&
                  (workspace.published ? (
                    <Link
                      className="button button-quiet"
                      href={`/tutors/${workspace.tutorId}`}
                    >
                      View public profile
                    </Link>
                  ) : (
                    <span
                      className="tooltip-wrap"
                      data-tip="Publish your listing first."
                    >
                      <button className="button button-quiet" disabled>
                        View public profile
                      </button>
                    </span>
                  ))}
              </div>
              {workspace.activation === "ACTIVE" &&
                account?.capabilities.includes("TUTOR") && (
                  <button
                    className="button"
                    disabled={action.pending || action.uncertain}
                    onClick={() =>
                      void action.run(
                        "/profiles/me/tutor/publication",
                        { published: !workspace.published },
                        "PATCH",
                        workspace.revision,
                      )
                    }
                  >
                    {workspace.published ? "Unpublish listing" : "Publish listing"}
                  </button>
                )}
            </div>
          </section>
          {current && profile && (
            <section className="panel booking-new">
              <h2>Current approved profile</h2>
              <h3>{current.headline}</h3>
              <p style={{ whiteSpace: "pre-wrap" }}>{current.bio}</p>
              <p className="tutor-card-meta">
                Stays public while you prepare or submit a revision.
              </p>
            </section>
          )}
          <h2 className="list-title">Drafts</h2>
          <div className="draft-list">
            {workspace.drafts.map((draft) => (
              <DraftRow
                key={`${draft.id}:${draft.revision}`}
                draft={draft}
                reload={resource.reload}
                onEdit={() => setEditing(draft.id)}
              />
            ))}
            <div className="draft-row">
              <span className="tutor-card-meta">
                {workspace.drafts.length === 0 ? "No drafts yet." : ""}
              </span>
              <button
                type="button"
                className="button button-quiet"
                onClick={() => setEditing("new")}
              >
                {workspace.tutorId ? "New profile revision" : "New application draft"}
              </button>
            </div>
          </div>
          {editing === "new" && (
            <DraftEditor
              key={`new-${workspace.drafts.length}`}
              seed={current}
              reload={resource.reload}
              onClose={() => setEditing(null)}
            />
          )}
          {workspace.drafts.map(
            (draft) =>
              editing === draft.id && (
                <DraftEditor
                  key={`${draft.id}:${draft.revision}`}
                  draft={draft}
                  reload={resource.reload}
                  onClose={() => setEditing(null)}
                />
              ),
          )}
          <h2 className="list-title">Submission history</h2>
          {workspace.submissions.length === 0 && (
            <p className="tutor-card-meta">No submissions yet.</p>
          )}
          <div className="draft-list">
            {[...workspace.submissions].sort((a, b) => (b.submittedAt ?? "").localeCompare(a.submittedAt ?? "")).map((submission) => (
              <SubmissionHistory
                key={`${submission.id}:${submission.revision}`}
                submission={submission}
                reload={resource.reload}
              />
            ))}
          </div>
        </>
      )}
    </>
  );
}
export function ApplicationWorkspace({
  profile = false,
}: {
  profile?: boolean;
}) {
  return (
    <RequireAuth>
      <ApplicationContent profile={profile} />
    </RequireAuth>
  );
}
