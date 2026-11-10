"use client";

import Link from "next/link";
import { useState } from "react";
import { StatusBadge, Pager, RequireCapability } from "@/features/wallet/common";
import { formatMoney, formatTime } from "@/features/wallet/format";
import { ActionMessages, ResourceState, TutorNavigation, useAction, useResource } from "@/features/tutor/common";
import type { Booking, BookingPage } from "./types";

function LessonCard({ booking, confirmable, onDone }: { booking: Booking; confirmable: boolean; onDone: () => void }) {
  const action = useAction(onDone);
  const meeting = booking.meeting.state === "READY" ? "Link ready" : booking.meeting.state === "MISSING" ? "No link yet" : booking.meeting.state === "PROVISIONING" ? "Being prepared" : "Closed";
  return (
    <article className="panel tutor-card">
      <StatusBadge value={booking.status} corner />
      <h3 className="lesson-title">
        <Link href={`/bookings/${booking.id}`}>{booking.subject.name}</Link>
      </h3>
      <p className="tutor-card-meta">{booking.studentDisplayName}, {formatTime(booking.startsAt)}</p>
      <p className="tutor-card-meta">{formatMoney(booking.amount)}, Online, meeting: {meeting.toLowerCase()}</p>
      {booking.description && <p className="tutor-card-meta">“{booking.description}”</p>}
      <ActionMessages action={action} />
      {confirmable && (
        <button
          className="button"
          disabled={action.pending}
          onClick={() => void action.run(`/bookings/${booking.id}/confirm-completion`, undefined, "POST", booking.revision)}
        >
          {action.pending ? "Confirming…" : "Confirm completed"}
        </button>
      )}
    </article>
  );
}

function LessonList({ path, empty, confirmable }: { path: string; empty: string; confirmable: boolean }) {
  const [page, setPage] = useState(1);
  const resource = useResource<BookingPage>(`${path}?page=${page}&pageSize=20`);
  return (
    <>
      <ResourceState loading={resource.loading} error={resource.error} failure={resource.failure} retry={resource.reload} />
      {resource.data?.items.length === 0 && <p className="tutor-card-meta">{empty}</p>}
      <div className="tx-list">
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
      <header className="page-heading"><h1>Your lessons</h1></header>
      <TutorNavigation />
      <h2 className="list-title first">Needs your confirmation</h2>
      <LessonList path="/bookings/tutor/needs-confirmation" empty="Nothing is waiting for your confirmation." confirmable />
      <h2 className="list-title">Upcoming</h2>
      <LessonList path="/bookings/tutor/upcoming" empty="No upcoming lessons yet. Open availability so students can book you." confirmable={false} />
    </RequireCapability>
  );
}
