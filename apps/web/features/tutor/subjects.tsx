"use client";

import Link from "next/link";
import { useState } from "react";
import { RequireAuth, useAuth } from "@/lib/auth-context";
import { Field, Notice } from "@/components/field";
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
}: {
  subject?: Subject;
  areas: LearningAreas;
  reload: () => Promise<void>;
}) {
  const action = useAction(reload);
  const [validation, setValidation] = useState("");
  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setValidation("");
    const form = new FormData(event.currentTarget);
    const rawRate = String(form.get("hourlyRate") ?? "").trim();
    // Accept "450" or "450.5" and normalise to two decimals.
    const hourlyRate = /^\d{1,8}(?:\.\d{1,2})?$/.test(rawRate)
      ? Number(rawRate).toFixed(2)
      : rawRate;
    const learningAreas = form.getAll("learningAreas").map(String);
    if (
      !/^(?:0|[1-9]\d{0,7})\.\d{2}$/.test(hourlyRate) ||
      /^0\.00$/.test(hourlyRate)
    ) {
      setValidation(
        "Enter a positive rate in baht, such as 400 or 400.50.",
      );
      return;
    }
    if (learningAreas.length < 1 || learningAreas.length > 3) {
      setValidation("Choose one to three learning areas.");
      return;
    }
    const body = {
      name: String(form.get("name") ?? "").trim(),
      description: String(form.get("description") ?? "").trim(),
      hourlyRate,
      format: "ONLINE",
      learningAreas,
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
    <section className="panel">
      <h2>{subject ? `Edit ${subject.name}` : "Create a subject"}</h2>
      <ActionMessages action={action} />
      {validation && <Notice kind="error">{validation}</Notice>}
      <form className="form" onSubmit={(event) => void save(event)}>
        <Field
          id={`name-${subject?.id ?? "new"}`}
          name="name"
          label="Subject name"
          required
          maxLength={100}
          defaultValue={subject?.name ?? ""}
        />
        <div className="field">
          <label htmlFor={`description-${subject?.id ?? "new"}`}>
            Description
          </label>
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
        <p>
          Lesson format: <strong>Online</strong>
        </p>
        <fieldset className="field">
          <legend>Learning areas (choose 1 to 3)</legend>
          {areas.items.map((area) => (
            <label key={area.id} className="check-row">
              <input
                type="checkbox"
                name="learningAreas"
                value={area.id}
                defaultChecked={subject?.learningAreas.includes(area.id)}
              />
              <span>{area.label}</span>
            </label>
          ))}
        </fieldset>
        <button
          className="button"
          disabled={action.pending || action.uncertain}
        >
          {action.pending
            ? "Saving..."
            : subject
              ? "Save subject"
              : "Create subject"}
        </button>
      </form>
      <p className="muted">
        These changes apply to future bookings. Existing bookings keep their
        original subject and rate.
      </p>
    </section>
  );
}
function SubjectsContent() {
  const { account } = useAuth();
  const [page, setPage] = useState(1);
  const resource = useResource<Page<Subject>>(
    account?.capabilities.includes("TUTOR")
      ? `/profiles/me/tutor/subjects?page=${page}&pageSize=20`
      : null,
  );
  const areas = useResource<LearningAreas>("/discovery/learning-areas", false);
  return (
    <>
      <header className="section-heading">
        <h1>Subjects</h1>
        <p>
          Manage your online offerings. Opening half-hour slots is not
          available yet.
        </p>
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
              <SubjectEditor
                key={`new-${resource.data.pagination.totalItems}`}
                areas={areas.data}
                reload={resource.reload}
              />
              <h2>Your offerings</h2>
              {resource.data.items.length === 0 && (
                <p className="empty-state">No subjects yet.</p>
              )}
              {resource.data.items.map((subject) => (
                <SubjectEditor
                  key={`${subject.id}:${subject.revision}`}
                  subject={subject}
                  areas={areas.data!}
                  reload={resource.reload}
                />
              ))}
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
