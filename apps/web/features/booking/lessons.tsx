"use client";

import Link from "next/link";
import { useState } from "react";
import { StatusBadge, Pager, RequireCapability } from "@/features/wallet/common";
import { formatMoney, formatTime } from "@/features/wallet/format";
import { ActionMessages, ResourceState, TutorNavigation, useAction, useResource } from "@/features/tutor/common";
import type { Booking, BookingPage } from "./types";

function LessonCard({ booking, confirmable, onDone }: { booking: Booking; confirmable: boolean; onDone: () => void }) {
  const action = useAction(onDone);
  return (
    <article className="panel">
      <div className="stat-line">
        <StatusBadge value={booking.status} />
        <span>{formatTime(booking.startsAt)}</span>
      </div>
      <h2>{booking.subject.name}</h2>
      <p>
        Student: {booking.studentDisplayName}, <strong>{formatMoney(booking.amount)}</strong>
      </p>
      {booking.description && <p className="muted">“{booking.description}”</p>}
      <p className="small-muted">
        Meeting: {booking.meeting.state === "READY" ? "link ready" : booking.meeting.state === "MISSING" ? "no link yet — add one on the booking page" : booking.meeting.state === "PROVISIONING" ? "being prepared" : "closed"}
      </p>
      <ActionMessages action={action} />
      <div className="button-row">
        <Link className="button button-outline" href={`/bookings/${booking.id}`}>
          View booking
        </Link>
        {confirmable && (
          <button
            className="button"
            disabled={action.pending}
            onClick={() => void action.run(`/bookings/${booking.id}/confirm-completion`, undefined, "POST", booking.revision)}
          >
            {action.pending ? "Confirming…" : "Confirm lesson completed"}
          </button>
        )}
      </div>
    </article>
  );
}

function LessonList({ path, empty, confirmable }: { path: string; empty: string; confirmable: boolean }) {
  const [page, setPage] = useState(1);
  const resource = useResource<BookingPage>(`${path}?page=${page}&pageSize=20`);
  return (
    <>
      <ResourceState loading={resource.loading} error={resource.error} failure={resource.failure} retry={resource.reload} />
      {resource.data?.items.length === 0 && <p className="empty-state">{empty}</p>}
      <div className="account-grid">
        {resource.data?.items.map((booking) => (
          <LessonCard key={booking.id} booking={booking} confirmable={confirmable} onDone={resource.reload} />
        ))}
      </div>
      {resource.data && <Pager meta={resource.data.pagination} onPage={setPage} disabled={resource.loading} />}
    </>
  );
}

export function LessonsPage() {
  return (
    <RequireCapability capability="TUTOR">
      <TutorNavigation />
      <header className="section-heading">
        <h1>Your lessons</h1>
        <p>Confirm lessons once they have ended so your earnings can start clearing, and see what is coming up.</p>
      </header>
      <section className="panel">
        <h2>Needs your confirmation</h2>
        <p>These lessons have ended. Confirm the ones that took place.</p>
        <LessonList path="/bookings/tutor/needs-confirmation" empty="Nothing is waiting for your confirmation." confirmable />
      </section>
      <section className="panel">
        <h2>Upcoming lessons</h2>
        <LessonList path="/bookings/tutor/upcoming" empty="No upcoming lessons yet. Open availability so students can book you." confirmable={false} />
      </section>
    </RequireCapability>
  );
}
