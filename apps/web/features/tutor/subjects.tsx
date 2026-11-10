"use client";

import Link from "next/link";
import { useState } from "react";
import { RequireAuth, useAuth } from "@/lib/auth-context";
import { Field, Notice } from "@/components/field";
import { LegalModal } from "@/components/legal-modal";
import {
  ActionMessages,
  Pager,
  ResourceState,
  TutorNavigation,
  useAction,
  useResource,
} from "./common";
import type { LearningAreas, Page, Subject } from "./types";

function SubjectEditor({
  subject,
  areas,
  reload,
  onClose,
}: {
  subject?: Subject;
  areas: LearningAreas;
  reload: () => Promise<void>;
  onClose: () => void;
}) {
  const action = useAction(async () => {
    await reload();
    onClose();
  });
  const [validation, setValidation] = useState("");
  const [chosen, setChosen] = useState<string[]>(subject?.learningAreas ?? []);
  const formId = `subject-form-${subject?.id ?? "new"}`;
  function toggle(id: string) {
    setChosen((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id],
    );
  }
  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setValidation("");
    const form = new FormData(event.currentTarget);
    const rawRate = String(form.get("hourlyRate") ?? "").trim();
    // Accept "450" or "450.5" and normalise to two decimals.
    const hourlyRate = /^\d{1,8}(?:\.\d{1,2})?$/.test(rawRate)
      ? Number(rawRate).toFixed(2)
      : rawRate;
    if (
      !/^(?:0|[1-9]\d{0,7})\.\d{2}$/.test(hourlyRate) ||
      /^0\.00$/.test(hourlyRate)
    ) {
      setValidation("Enter a positive rate in baht, such as 400 or 400.50.");
      return;
    }
    if (chosen.length < 1 || chosen.length > 3) {
      setValidation("Choose one to three learning areas.");
      return;
    }
    const body = {
      name: String(form.get("name") ?? "").trim(),
      description: String(form.get("description") ?? "").trim(),
      hourlyRate,
      format: "ONLINE",
      learningAreas: chosen,
    };
    await action.run(
      subject
        ? `/profiles/me/tutor/subjects/${subject.id}`
        : "/profiles/me/tutor/subjects",
      body,
      subject ? "PUT" : "POST",
      subject?.revision,
    );
  }
  return (
    <LegalModal
      open
      onClose={onClose}
      title={subject ? "Edit subject" : "New subject"}
      actions={
        <div className="button-row" style={{ justifyContent: "flex-end" }}>
          <button type="button" className="button button-quiet" onClick={onClose}>
            Cancel
          </button>
          <button className="button" form={formId} disabled={action.pending || action.uncertain}>
            {action.pending ? "Saving..." : "Save subject"}
          </button>
        </div>
      }
    >
      <ActionMessages action={action} />
      {validation && <Notice kind="error">{validation}</Notice>}
      <form id={formId} className="form" onSubmit={(event) => void save(event)}>
        <Field
          id={`name-${subject?.id ?? "new"}`}
          name="name"
          label="Subject name"
          required
          maxLength={100}
          defaultValue={subject?.name ?? ""}
        />
        <div className="field">
          <label htmlFor={`description-${subject?.id ?? "new"}`}>Description</label>
          <textarea
            id={`description-${subject?.id ?? "new"}`}
            name="description"
            required
            maxLength={2000}
            rows={4}
            defaultValue={subject?.description ?? ""}
          />
        </div>
        <Field
          id={`rate-${subject?.id ?? "new"}`}
          name="hourlyRate"
          label="Hourly rate (THB)"
          required
          inputMode="decimal"
          placeholder="400.00"
          defaultValue={subject?.hourlyRate ?? ""}
        />
        <div className="field">
          <span className="field-label">Learning areas (choose 1 to 3)</span>
          <div className="topup-quick" role="group" aria-label="Learning areas">
            {areas.items.map((area) => (
              <button
                type="button"
                key={area.id}
                className="topup-chip"
                aria-pressed={chosen.includes(area.id)}
                onClick={() => toggle(area.id)}
              >
                {area.label}
              </button>
            ))}
          </div>
        </div>
      </form>
      <p className="tutor-card-meta">
        Lessons are online. Changes apply to future bookings; existing bookings
        keep their original subject and rate.
      </p>
    </LegalModal>
  );
}
function SubjectsContent() {
  const { account } = useAuth();
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<string | null>(null);
  const resource = useResource<Page<Subject>>(
    account?.capabilities.includes("TUTOR")
      ? `/profiles/me/tutor/subjects?page=${page}&pageSize=20`
      : null,
  );
  const areas = useResource<LearningAreas>("/discovery/learning-areas", false);
  return (
    <>
      <header className="page-heading page-heading-row">
        <h1>Subjects</h1>
        {account?.capabilities.includes("TUTOR") && (
          <button className="button" onClick={() => setEditing("new")}>
            New subject
          </button>
        )}
      </header>
      <TutorNavigation />
      {!account?.capabilities.includes("TUTOR") ? (
        <Notice kind="info">
          Approved and activated Tutor access is required to manage subjects.{" "}
          <Link className="text-link" href="/teach/application">
            Apply to become a tutor
          </Link>
        </Notice>
      ) : (
        <>
          <ResourceState
            loading={resource.loading || areas.loading}
            error={resource.error || areas.error}
            retry={() => {
              void resource.reload();
              void areas.reload();
            }}
          />
          {resource.data && areas.data && (
            <>
              {resource.data.items.length === 0 && (
                <p className="tutor-card-meta">No subjects yet.</p>
              )}
              <div className="draft-list">
                {resource.data.items.map((subject) => (
                  <div className="draft-row" key={subject.id}>
                    <span className="subject-row-main">
                      <strong>{subject.name}</strong>
                      <small>THB {subject.hourlyRate}/hour</small>
                    </span>
                    <button
                      className="button button-quiet"
                      onClick={() => setEditing(subject.id)}
                    >
                      Edit
                    </button>
                  </div>
                ))}
              </div>
              {editing === "new" && (
                                  <SubjectEditor
                    key={`new-${resource.data.pagination.totalItems}`}
                    areas={areas.data}
                    reload={resource.reload}
                    onClose={() => setEditing(null)}
                  />
              )}
              {resource.data.items.map(
                (subject) =>
                  editing === subject.id && (
                    <SubjectEditor
                      key={`${subject.id}:${subject.revision}`}
                      subject={subject}
                      areas={areas.data!}
                      reload={resource.reload}
                      onClose={() => setEditing(null)}
                    />
                  ),
              )}
              <Pager pagination={resource.data.pagination} onPage={setPage} />
            </>
          )}
        </>
      )}
    </>
  );
}
export function SubjectsWorkspace() {
  return (
    <RequireAuth>
      <SubjectsContent />
    </RequireAuth>
  );
}
