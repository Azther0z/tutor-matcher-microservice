"use client";

import { useState } from "react";
import Link from "next/link";
import { RequireAuth, useAuth } from "@/lib/auth-context";
import { Field, Notice } from "@/components/field";
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
}: {
  draft?: Submission;
  seed?: Submission;
  reload: () => Promise<void>;
}) {
  const value = draft ?? seed;
  const action = useAction(reload);
  const [consent, setConsent] = useState(false);
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
  return (
    <section className="panel">
      <h2>
        {draft
          ? "Edit draft"
          : seed
            ? "New profile revision"
            : "New tutor application"}
      </h2>
      <p>
        Drafts can be incomplete. Submitting requires a bio, identification
        document URL, introduction video URL and consent. Submitted versions
        cannot be edited.
      </p>
      <ActionMessages action={action} />
      <form className="form" onSubmit={(event) => void save(event)}>
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
          label="Identification document URL (private)"
          type="url"
          placeholder="https://example.test/synthetic-document"
          defaultValue={value?.identificationDocumentUrl ?? ""}
        />
        <Field
          id={`video-${draft?.id ?? "new"}`}
          name="introVideoUrl"
          label="Introduction video URL"
          type="url"
          defaultValue={value?.introVideoUrl ?? ""}
        />
        <Field
          id={`avatar-${draft?.id ?? "new"}`}
          name="avatarUrl"
          label="Avatar URL (optional)"
          type="url"
          defaultValue={value?.avatarUrl ?? ""}
        />
        <p className="muted">
          Use HTTPS links. Your document is visible only to you and authorized
          admins. File upload is not required.
        </p>
        <button
          className="button"
          disabled={action.pending || action.uncertain}
        >
          {action.pending ? "Saving..." : "Save draft"}
        </button>
      </form>
      {draft && (
        <>
          <hr className="divider" />
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
          <p className="muted">
            Save your latest changes above before submitting.
          </p>
          <div className="button-row">
            <button
              className="button"
              disabled={!consent || action.pending || action.uncertain}
              onClick={() =>
                void action.run(
                  `/profiles/me/tutor/drafts/${draft.id}/submit`,
                  { consentAccepted: true },
                  "POST",
                  draft.revision,
                )
              }
            >
              Submit saved draft
            </button>
            <button
              className="button button-danger"
              disabled={action.pending || action.uncertain}
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
          </div>
        </>
      )}
    </section>
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
    <article className="panel">
      <div className="stat-line">
        <strong>
          {submission.kind === "APPLICATION"
            ? "Application"
            : "Profile revision"}
        </strong>
        <span className="badge">{submission.state}</span>
        <span>Activation: {submission.activation}</span>
      </div>
      <h3>{submission.headline || "Tutor profile"}</h3>
      <p style={{ whiteSpace: "pre-wrap" }}>{submission.bio}</p>
      {submission.submittedAt && (
        <p>Submitted {bangkokTime(submission.submittedAt)} (Bangkok)</p>
      )}
      {submission.reviewedAt && (
        <p>Reviewed {bangkokTime(submission.reviewedAt)} (Bangkok)</p>
      )}
      {submission.rejectionReason && (
        <Notice kind="error">
          Review reason: {submission.rejectionReason}
        </Notice>
      )}
      {submission.identificationDocumentUrl && (
        <p>
          <a
            className="text-link"
            href={submission.identificationDocumentUrl}
            rel="noreferrer"
            target="_blank"
          >
            View your private identification document
          </a>
        </p>
      )}
      <ActionMessages action={action} />
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
          Withdraw submission
        </button>
      )}
      {["REJECTED", "CANCELLED"].includes(submission.state) && (
        <button
          className="button"
          disabled={action.pending || action.uncertain}
          onClick={() =>
            void action.run(
              `/profiles/me/tutor/submissions/${submission.id}/copy`,
            )
          }
        >
          Copy into a new draft
        </button>
      )}
    </article>
  );
}
function ApplicationContent({ profile = false }: { profile?: boolean }) {
  const resource = useResource<Workspace>("/profiles/me/tutor");
  const action = useAction(resource.reload);
  const { account, refresh } = useAuth();
  const [showNew, setShowNew] = useState(false);
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
      <header className="section-heading">
        <h1>{profile ? "Profile and publication" : "Tutor application"}</h1>
        <p>
          One account for learning and teaching. Your approved profile stays
          public while a revision is reviewed.
        </p>
      </header>
      <TutorNavigation />
      <ResourceState
        loading={resource.loading}
        error={resource.error}
        retry={() => void resource.reload()}
      />
      {workspace && (
        <>
          <section className="panel">
            <h2>Your tutor status</h2>
            <p>
              Activation: <strong>{workspace.activation}</strong>. Listing:{" "}
              <strong>
                {workspace.published ? "Published" : "Unpublished"}
              </strong>
              .
            </p>
            {workspace.activation === "PENDING" && (
              <Notice kind="info">
                Your application was approved. Tutor access is still being
                activated. You can publish and manage subjects after activation
                is confirmed.
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
            <div className="button-row">
              <button
                className="button button-quiet"
                onClick={() => void resource.reload()}
              >
                Refresh tutor status
              </button>
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
                    {workspace.published
                      ? "Unpublish listing"
                      : "Publish listing"}
                  </button>
                )}
              {workspace.tutorId && (
                <Link
                  className="text-link"
                  href={`/tutors/${workspace.tutorId}`}
                >
                  View public profile
                </Link>
              )}
            </div>
            {!workspace.published && (
              <p>
                Unpublished listings do not appear in discovery. Existing
                bookings and conversations remain available.
              </p>
            )}
          </section>
          {current && profile && (
            <section className="panel">
              <h2>Current approved content</h2>
              <h3>{current.headline}</h3>
              <p style={{ whiteSpace: "pre-wrap" }}>{current.bio}</p>
              <p>
                This content remains approved while you prepare or submit a
                revision.
              </p>
            </section>
          )}
          <div className="button-row">
            <button className="button" onClick={() => setShowNew(!showNew)}>
              {showNew
                ? "Close new draft"
                : workspace.tutorId
                  ? "Create profile revision"
                  : "Create application draft"}
            </button>
          </div>
          {showNew && (
            <DraftEditor
              key={workspace.drafts.length}
              seed={current}
              reload={resource.reload}
            />
          )}
          <h2>Editable drafts</h2>
          {workspace.drafts.length === 0 && (
            <p className="empty-state">You have no saved drafts.</p>
          )}
          {workspace.drafts.map((draft) => (
            <DraftEditor
              key={`${draft.id}:${draft.revision}`}
              draft={draft}
              reload={resource.reload}
            />
          ))}
          <h2>Submission history</h2>
          {workspace.submissions.length === 0 && (
            <p className="empty-state">No submissions yet.</p>
          )}
          {workspace.submissions.map((submission) => (
            <SubmissionHistory
              key={`${submission.id}:${submission.revision}`}
              submission={submission}
              reload={resource.reload}
            />
          ))}
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
