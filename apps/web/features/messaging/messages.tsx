"use client";

import Link from "next/link";
import { Fragment, use, useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Notice } from "@/components/field";
import { Avatar } from "@/components/avatar";
import type { BookingPage } from "@/features/booking/types";
import { RequireAuth, useAuth } from "@/lib/auth-context";
import { api, errorMessage, isUuid, newIdempotencyKey } from "@/lib/api";
import { formatTime } from "@/features/wallet/format";
import type { PageMeta } from "@/lib/types";

type Message = {
  id: string;
  conversationId: string;
  senderUserId: string;
  recipientUserId: string;
  content: string;
  createdAt: string;
};
type Conversation = {
  id: string;
  kind: "STUDENT_TUTOR" | "ADMIN_SUPPORT";
  lastMessage: Message | null;
  unreadCount: number;
  participants: Array<{ userId: string; displayName: string }>;
};
type ConversationPage = { items: Conversation[]; pagination: PageMeta };
type ThreadPage = {
  conversation: Conversation | null;
  items: Message[];
  nextCursor: string | null;
};

const dayFormat = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok" });
const clockFormat = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Bangkok", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const dayLabelFormat = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Bangkok", weekday: "short", day: "numeric", month: "short" });
const dayKey = (value: string) => dayFormat.format(new Date(value));
const clock = (value: string) => clockFormat.format(new Date(value));

/** "Today", "Yesterday" or "Wed, 11 Nov": the label chat apps put between days. */
function dayLabel(value: string) {
  const day = dayKey(value);
  if (day === dayFormat.format(new Date())) return "Today";
  if (day === dayFormat.format(new Date(Date.now() - 86400000))) return "Yesterday";
  return dayLabelFormat.format(new Date(value));
}

function Inbox() {
  const { account } = useAuth();
  const [view, setView] = useState<"STUDENT" | "TUTOR" | "ADMIN">("STUDENT");
  const [result, setResult] = useState<ConversationPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setResult(
        await api<ConversationPage>(
          `/messages/inbox?page=1&pageSize=20&view=${view}`,
        ),
      );
    } catch (caught) {
      setResult(null);
      setError(errorMessage(caught, "Messages are unavailable right now."));
    } finally {
      setLoading(false);
    }
  }, [view]);
  useEffect(() => {
    void load();
  }, [load]);
  const views = [
    "STUDENT",
    account?.capabilities.includes("TUTOR") ? "TUTOR" : null,
    account?.capabilities.includes("ADMIN") ? "ADMIN" : null,
  ].filter(Boolean) as Array<"STUDENT" | "TUTOR" | "ADMIN">;
  return (
    <>
      <header className="page-heading">
        <h1>Messages</h1>
      </header>
      {views.length > 1 && (
        <div className="view-switch" role="group" aria-label="Message view">
          {views.map((value) => (
            <button
              key={value}
              className={`button ${view === value ? "" : "button-quiet"}`}
              onClick={() => setView(value)}
            >
              {value === "STUDENT"
                ? "As a student"
                : value === "TUTOR"
                  ? "As a tutor"
                  : "Support"}
            </button>
          ))}
        </div>
      )}
      {loading && <p role="status" className="tutor-card-meta">Loading conversations…</p>}
      {error && (
        <Notice kind="error">
          {error}{" "}
          <button className="button button-quiet" onClick={() => void load()}>
            Try again
          </button>
        </Notice>
      )}
      {result?.items.length === 0 && (
        <p className="tutor-card-meta">
          No conversations yet. Open a tutor profile to ask about a subject or lesson.
        </p>
      )}
      <div className="message-list">
        {result?.items.map((conversation) => {
          const other = conversation.participants.find(
            (participant) => participant.userId !== account?.id,
          );
          return (
            <Link
              className="message-row"
              key={conversation.id}
              href={`/messages/${other?.userId}?${new URLSearchParams({ view, ...(other?.displayName ? { name: other.displayName } : {}) })}`}
            >
              <span className="message-who">
                <Avatar name={other?.displayName ?? "?"} size={40} />
                <span>
                  <strong>{other?.displayName ?? "Conversation"}</strong>
                  {conversation.lastMessage && (
                    <small>{conversation.lastMessage.content}</small>
                  )}
                </span>
              </span>
              <span>
                {conversation.unreadCount > 0 && (
                  <span
                    className="unread-badge"
                    aria-label={`${conversation.unreadCount} unread messages`}
                  >
                    {conversation.unreadCount}
                  </span>
                )}
                {conversation.lastMessage && (
                  <small>
                    {formatTime(conversation.lastMessage.createdAt)}
                  </small>
                )}
              </span>
            </Link>
          );
        })}
      </div>
    </>
  );
}

export function MessagesPage() {
  return (
    <RequireAuth>
      <Inbox />
    </RequireAuth>
  );
}

function Thread({ userId }: { userId: string }) {
  const params = useSearchParams();
  const { account } = useAuth();
  const requestedView = params.get("view");
  const view =
    requestedView === "TUTOR" && account?.capabilities.includes("TUTOR")
      ? "TUTOR"
      : requestedView === "ADMIN" && account?.capabilities.includes("ADMIN")
        ? "ADMIN"
        : "STUDENT";
  const [thread, setThread] = useState<ThreadPage | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [key, setKey] = useState(newIdempotencyKey());
  const scroller = useRef<HTMLDivElement>(null);
  const [lookedUp, setLookedUp] = useState("");
  const [draft, setDraft] = useState("");
  const load = useCallback(async () => {
    setError("");
    try {
      const result = await api<ThreadPage>(
        `/messages/thread/${userId}?view=${view}&limit=50`,
      );
      setThread(result);
      const latestUnread = [...result.items]
        .reverse()
        .find((message) => message.recipientUserId === account?.id);
      if (latestUnread)
        void api(`/messages/thread/${userId}/read?view=${view}`, {
          method: "PUT",
          body: { lastReadMessageId: latestUnread.id },
          idempotencyKey: newIdempotencyKey(),
        }).catch(() => setNotice("The conversation loaded, but its read status could not be updated."));
    } catch (caught) {
      setError(
        errorMessage(caught, "This conversation is unavailable right now."),
      );
    }
  }, [userId, view, account?.id]);
  useEffect(() => {
    if (isUuid(userId)) void load();
  }, [load, userId]);
  // Before the first message the thread has no participant names, so find the person among the caller's bookings.
  const hasName = Boolean(thread?.conversation) || Boolean(params.get("name"));
  useEffect(() => {
    if (!thread || hasName || !isUuid(userId)) return;
    const views = account?.capabilities.includes("TUTOR") ? ["STUDENT", "TUTOR"] : ["STUDENT"];
    void Promise.all(views.map((v) => api<BookingPage>(`/bookings?page=1&pageSize=50&view=${v}`).catch(() => null))).then((pages) => {
      for (const page of pages) {
        for (const booking of page?.items ?? []) {
          if (booking.tutorUserId === userId) return setLookedUp(booking.tutorDisplayName);
          if (booking.studentUserId === userId) return setLookedUp(booking.studentDisplayName);
        }
      }
    });
  }, [thread, hasName, userId, account?.capabilities]);
  // Newest messages are at the bottom; keep them in view.
  useEffect(() => {
    const node = scroller.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [thread?.items.length]);
  async function send(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const content = draft.trim();
    if (!content || pending) return;
    setPending(true);
    setError("");
    setNotice("");
    try {
      await api<Message>("/messages", {
        method: "POST",
        body: { recipientId: userId, view, content },
        idempotencyKey: key,
      });
      setDraft("");
      setKey(newIdempotencyKey());
      await load();
    } catch (caught) {
      setError(errorMessage(caught, "We couldn’t send your message."));
    } finally {
      setPending(false);
    }
  }
  if (!isUuid(userId))
    return (
      <section className="panel">
        <h1 style={{ fontSize: 22 }}>We couldn’t find that conversation.</h1>
      </section>
    );
  const other = thread?.conversation?.participants.find(
    (participant) => participant.userId !== account?.id,
  );
  const shownName = other?.displayName ?? params.get("name")?.slice(0, 80) ?? (lookedUp || "Conversation");
  return (
    <>
      <header className="page-heading chat-head">
        <Avatar name={shownName} size={36} />
        <h1>{shownName}</h1>
      </header>
      {error && (
        <Notice kind="error">
          {error}{" "}
          {!thread && (
            <button className="button button-quiet" onClick={() => void load()}>
              Try again
            </button>
          )}
        </Notice>
      )}
      {notice && <Notice kind="success">{notice}</Notice>}
      {!thread && !error && <p role="status" className="tutor-card-meta">Loading conversation…</p>}
      {thread && (
        <section className="panel chat">
          <div className="thread" ref={scroller} aria-live="polite">
            {thread.items.length === 0 && (
              <p className="chat-empty">No messages yet. Say hello below.</p>
            )}
            {thread.items.map((message, index) => {
              const previous = thread.items[index - 1];
              const next = thread.items[index + 1];
              const own = message.senderUserId === account?.id;
              const newDay = !previous || dayKey(previous.createdAt) !== dayKey(message.createdAt);
              // A run of messages from one person in the same minute shows its time once, after the last one.
              const lastOfRun =
                !next ||
                next.senderUserId !== message.senderUserId ||
                clock(next.createdAt) !== clock(message.createdAt) ||
                dayKey(next.createdAt) !== dayKey(message.createdAt);
              const joinsPrevious =
                !newDay && previous?.senderUserId === message.senderUserId;
              return (
                <Fragment key={message.id}>
                  {newDay && <div className="chat-day">{dayLabel(message.createdAt)}</div>}
                  <div className={`chat-line ${own ? "own" : ""}${joinsPrevious ? " joined" : ""}`}>
                    <article className={`message-bubble ${own ? "own" : ""}`}>
                      <p>{message.content}</p>
                    </article>
                    {lastOfRun && <time dateTime={message.createdAt}>{clock(message.createdAt)}</time>}
                  </div>
                </Fragment>
              );
            })}
          </div>
          <form className="chat-composer" onSubmit={send}>
            <input
              id="content"
              name="content"
              type="text"
              autoComplete="off"
              aria-label="Message"
              placeholder="Write a message"
              maxLength={2000}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
            />
            <button className="chat-send" disabled={pending || !draft.trim()} aria-label="Send message" title="Send">
              <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M17.5 2.5 8.75 11.25M17.5 2.5l-5.5 15-3.25-6.25L2.5 8 17.5 2.5Z" />
              </svg>
            </button>
          </form>
        </section>
      )}
    </>
  );
}

export function MessageThreadPage({
  params,
}: {
  params: Promise<{ userId: string }>;
}) {
  const { userId } = use(params);
  return (
    <RequireAuth>
      <Thread userId={userId} />
    </RequireAuth>
  );
}
